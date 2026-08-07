/**
 * Meetfleet — web messaging: data layer.
 *
 * A browser port of mobile/services/messages.ts + supabasemessaging.ts, kept
 * deliberately close to the originals so the two clients agree on every wire
 * shape. The same RPCs, the same `messages` columns, the same client_id upsert:
 * a message sent here is indistinguishable from one sent by the app.
 *
 * What is intentionally NOT ported:
 *   • the AsyncStorage disk cache — a browser tab is short-lived, and a stale
 *     localStorage copy of every thread is a liability, not an optimisation.
 *     The in-memory cache and the stale-while-revalidate policy remain.
 *   • plan hydration on conversations — /messages never renders a plan card.
 *
 * RPC contract (all live for the app):
 *   get_user_conversations, get_or_create_conversation, mark_conversation_read,
 *   get_partner_last_read, is_conversation_participant
 */

import { supabase } from './supabase.js';

/* ═══════════════════════════════════════════════════════════════════════════
   Message shape
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Types the web client renders natively. Everything else — plan, music,
 * dark_room_invite — is a mobile-only experience and gets the single
 * "open the app" bubble instead of a broken half-widget.
 */
export const WEB_RENDERABLE_TYPES = new Set([
  'text', 'system', 'image', 'voice', 'contact', 'location',
]);

/** Types that exist only in the app. Kept explicit so a new one fails loudly. */
export const APP_ONLY_TYPES = new Set(['plan', 'music', 'dark_room_invite']);

/**
 * Normalise a row from `messages` into the shape the UI renders.
 *
 * `metadata.originalType` wins over the column: the app writes certain
 * messages with a compatible `type` for older builds and records the real one
 * in metadata. Reading it the same way here keeps old threads correct.
 * Mirrors mapSupabaseMessage() in mobile/services/messages.ts.
 */
export function mapMessage(row) {
  const metadata = typeof row.metadata === 'string'
    ? safeParse(row.metadata)
    : (row.metadata ?? undefined);

  const senderId = row.sender_id ?? row.senderId;
  const type = metadata?.originalType
    ?? row.type
    ?? (senderId === 'system' ? 'system' : 'text');

  const replyTo = row.reply_to ?? row.replyTo ?? undefined;

  return {
    id: row.id,
    clientId: row.client_id ?? row.clientId ?? row.id,
    conversationId: row.conversation_id ?? row.conversationId,
    senderId,
    text: row.text ?? '',
    createdAt: row.created_at ?? row.createdAt,
    type,
    metadata,
    locationCoords: row.location_coords ?? row.locationCoords,
    ...(replyTo ? { replyTo } : {}),
  };
}

function safeParse(raw) {
  try { return JSON.parse(raw); } catch { return undefined; }
}

/** True when this message can only be understood inside the mobile app. */
export function isAppOnly(message) {
  return APP_ONLY_TYPES.has(message.type) || !WEB_RENDERABLE_TYPES.has(message.type);
}

/** One-line inbox preview for a message, matching the app's wording. */
export function previewFor(message) {
  switch (message.type) {
    case 'image':  return message.metadata?.kind === 'video' ? 'Video' : 'Photo';
    case 'voice':  return 'Voice note';
    case 'location': return 'Location';
    case 'contact': return message.metadata?.name || 'Contact';
    case 'music':  return 'Music';
    case 'plan':   return 'Shared a plan';
    case 'dark_room_invite': return 'Dark Room invite';
    default:       return message.text || '';
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Raw Supabase calls — mobile/services/supabasemessaging.ts
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Fetch the conversation list. Uses the SECURITY DEFINER RPC, which bypasses
 * the auth.uid()-based RLS the app also cannot satisfy (see migration_016).
 *
 * The mobile version additionally scans `messages` for legacy text-encoded
 * conversation ids that predate migration_008. That scan is a `.or()` with an
 * `ilike %userId%` — expensive, and every conversation reachable from the web
 * is post-migration, so it is deliberately omitted here.
 */
export async function fetchConversations(userId) {
  const { data, error } = await supabase
    .rpc('get_user_conversations', { requesting_user_id: userId });

  if (error) throw error;
  if (!Array.isArray(data)) return [];

  return data.map((row) => ({
    id: row.id,
    participantIds: row.participant_ids || [],
    lastMessage: row.lastMessage ?? undefined,
    lastMessageType: row.lastMessageType ?? 'text',
    updatedAt: row.updatedAt,
    planId: row.planId ?? undefined,
    unreadCount: Number(row.unread_count ?? row.unreadCount ?? 0),
  }));
}

export async function fetchMessages(conversationId) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return (data ?? []).map(mapMessage);
}

/** Delta-fetch for reconnect: only what arrived after `since` (ISO string). */
export async function fetchMessagesSince(conversationId, since) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .gt('created_at', since)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return (data ?? []).map(mapMessage);
}

/**
 * Insert a message, upserting on client_id so a retry can never duplicate.
 * Identical payload shape to sendMessageToSupabase() in the app.
 */
export async function insertMessage(conversationId, senderId, text, options = {}) {
  const payload = {
    conversation_id: conversationId,
    sender_id: senderId,
    text,
    type: options.type ?? 'text',
  };
  if (options.metadata) payload.metadata = options.metadata;
  if (options.locationCoords) payload.location_coords = options.locationCoords;
  if (options.clientId) payload.client_id = options.clientId;

  const { data, error } = await supabase
    .from('messages')
    .upsert(payload, { onConflict: 'client_id', ignoreDuplicates: false })
    .select()
    .single();

  if (error) throw error;
  return mapMessage(data);
}

/**
 * Resolve a users row to its subscription tier.
 *
 * Ported from the app's services/entitlements.ts — keep the two in step. A
 * lapsed subscriber is `free` whatever plan string they still carry; a premium
 * user on an unrecognised plan falls back to `basics` rather than being shown
 * as free while they are still paying.
 */
export function resolveTier(user) {
  if (!user?.isPremium) return 'free';
  const plan = user.subscriptionPlan;
  if (plan === 'basics' || plan === 'gold' || plan === 'onyx') return plan;
  return 'basics';
}

/** Profile fields the inbox and chat header need. Never throws on privacy. */
export async function fetchProfile(userId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, name, emoji, "avatarUrl", "dicebearAvatar", "isPremium", "subscriptionPlan"')
      .eq('id', userId)
      .single();
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Store — in-memory cache + subscriptions
   ═══════════════════════════════════════════════════════════════════════════ */

const MESSAGE_TTL_MS = 30_000;

class MessageStore {
  constructor() {
    this.userId = null;
    this.conversations = null;
    this.messages = new Map();          // conversationId -> Message[]
    this.fetchedAt = new Map();         // conversationId -> epoch ms
    this.inFlight = new Set();          // conversationId currently refreshing
    this.profiles = new Map();          // userId -> profile row
    this.inboxListeners = new Set();
    this.threadListeners = new Map();   // conversationId -> Set<fn>
  }

  /* ── subscriptions ──────────────────────────────────────────────────── */

  onInbox(fn) {
    this.inboxListeners.add(fn);
    return () => this.inboxListeners.delete(fn);
  }

  onThread(conversationId, fn) {
    if (!this.threadListeners.has(conversationId)) {
      this.threadListeners.set(conversationId, new Set());
    }
    this.threadListeners.get(conversationId).add(fn);
    return () => this.threadListeners.get(conversationId)?.delete(fn);
  }

  emitInbox() {
    if (!this.conversations) return;
    this.inboxListeners.forEach((fn) => fn(this.conversations));
  }

  emitThread(conversationId) {
    const messages = this.messages.get(conversationId) ?? [];
    this.threadListeners.get(conversationId)?.forEach((fn) => fn(messages));
  }

  /* ── conversations ──────────────────────────────────────────────────── */

  isKnownConversation(conversationId) {
    return Boolean(this.conversations?.some((c) => c.id === conversationId));
  }

  getConversation(conversationId) {
    return this.conversations?.find((c) => c.id === conversationId) ?? null;
  }

  /**
   * Load the inbox and hydrate each conversation with its partner profile.
   *
   * Partner lookups are memoised across refreshes: the inbox re-resolves every
   * 30s or on any realtime insert, and re-fetching the same handful of profiles
   * each time is pure waste.
   */
  async loadConversations(userId) {
    if (this.userId && this.userId !== userId) this.reset();
    this.userId = userId;

    const rows = await fetchConversations(userId);

    const hydrated = await Promise.all(rows.map(async (row) => {
      const partnerId = (row.participantIds || []).find((id) => id !== userId);
      const partner = partnerId ? await this.profileFor(partnerId) : null;

      return {
        id: row.id,
        planId: row.planId || 'direct',
        participantIds: row.participantIds,
        updatedAt: row.updatedAt,
        unreadCount: row.unreadCount ?? 0,
        lastMessageType: row.lastMessageType,
        lastMessage: previewForRow(row),
        partnerId: partner?.id ?? partnerId ?? null,
        name: partner?.username || 'Chat',
        displayName: partner?.name || partner?.username || 'Chat',
        avatarUrl: partner?.avatarUrl || partner?.dicebearAvatar || null,
        // Kept apart from avatarUrl: the profile card always shows the generated
        // avatar, even when the user has uploaded a photo over it.
        dicebearAvatar: partner?.dicebearAvatar || null,
        username: partner?.username || null,
        emoji: partner?.emoji || null,
        isPremium: Boolean(partner?.isPremium),
        subscriptionPlan: partner?.subscriptionPlan || null,
      };
    }));

    // The app dedupes by partner: a user can accumulate several conversation
    // rows with the same person (a direct one plus per-plan ones), and showing
    // all of them turns the inbox into a list of near-duplicates.
    const byPartner = new Map();
    for (const convo of hydrated) {
      const key = convo.partnerId ?? convo.id;
      const existing = byPartner.get(key);
      if (!existing || new Date(convo.updatedAt) > new Date(existing.updatedAt)) {
        byPartner.set(key, convo);
      }
    }

    this.conversations = Array.from(byPartner.values())
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    this.emitInbox();
    return this.conversations;
  }

  async profileFor(userId) {
    if (this.profiles.has(userId)) return this.profiles.get(userId);
    const profile = await fetchProfile(userId);
    if (profile) this.profiles.set(userId, profile);
    return profile;
  }

  /**
   * Patch the inbox from a message without a round-trip, so the preview and
   * unread badge move the instant a message lands.
   * Mirrors patchConversationFromMessage() in the app.
   */
  patchFromMessage(conversationId, message, incrementUnread) {
    if (!this.conversations) return;
    const idx = this.conversations.findIndex((c) => c.id === conversationId);
    if (idx === -1) {
      // First message from someone new — the row does not exist yet.
      if (this.userId) this.loadConversations(this.userId).catch(() => {});
      return;
    }

    const current = this.conversations[idx];
    const patched = {
      ...current,
      lastMessage: previewFor(message),
      lastMessageType: message.type,
      updatedAt: message.createdAt,
      unreadCount: incrementUnread ? (current.unreadCount ?? 0) + 1 : (current.unreadCount ?? 0),
    };

    this.conversations = [patched, ...this.conversations.filter((_, i) => i !== idx)];
    this.emitInbox();
  }

  /** Zero the unread badge locally and on the server. */
  async markRead(conversationId) {
    const idx = this.conversations?.findIndex((c) => c.id === conversationId) ?? -1;
    if (idx !== -1 && (this.conversations[idx].unreadCount ?? 0) > 0) {
      this.conversations = this.conversations.map((c, i) =>
        i === idx ? { ...c, unreadCount: 0 } : c);
      this.emitInbox();
    }

    if (!this.userId || !isUuid(conversationId)) return;
    try {
      await supabase.rpc('mark_conversation_read', {
        conv_id: conversationId,
        user_uuid: this.userId,
      });
    } catch (err) {
      console.warn('mark_conversation_read failed:', err);
    }
  }

  /** When the partner last read this thread — drives the "Seen" receipt. */
  async partnerLastReadAt(conversationId) {
    if (!this.userId || !isUuid(conversationId)) return null;
    try {
      const { data, error } = await supabase.rpc('get_partner_last_read', {
        conv_id: conversationId,
        current_user_uuid: this.userId,
      });
      if (error) return null;
      return data ?? null;
    } catch {
      return null;
    }
  }

  /* ── messages ───────────────────────────────────────────────────────── */

  cached(conversationId) {
    return this.messages.get(conversationId) ?? [];
  }

  /**
   * Stale-while-revalidate, matching the app:
   *   cache hit + fresh (<30s) → instant, no network
   *   cache hit + stale        → instant, refresh in background
   *   cache miss               → await the network
   */
  async loadMessages(conversationId) {
    const cached = this.messages.get(conversationId);

    if (cached?.length) {
      const age = Date.now() - (this.fetchedAt.get(conversationId) ?? 0);
      if (age > MESSAGE_TTL_MS) this.refreshInBackground(conversationId);
      return cached;
    }

    const fresh = await fetchMessages(conversationId);
    this.fetchedAt.set(conversationId, Date.now());
    this.messages.set(conversationId, fresh);
    return fresh;
  }

  refreshInBackground(conversationId) {
    if (this.inFlight.has(conversationId)) return;
    this.inFlight.add(conversationId);

    fetchMessages(conversationId)
      .then((fresh) => {
        const merged = merge(fresh, this.messages.get(conversationId) ?? []);
        this.fetchedAt.set(conversationId, Date.now());
        this.messages.set(conversationId, merged);
        this.emitThread(conversationId);
      })
      .catch(() => { /* non-critical — the cache is still on screen */ })
      .finally(() => this.inFlight.delete(conversationId));
  }

  /** Silently warm a thread so opening it is instant. */
  prefetch(conversationId) {
    if (this.inFlight.has(conversationId)) return;
    const age = Date.now() - (this.fetchedAt.get(conversationId) ?? 0);
    if (this.messages.has(conversationId) && age < MESSAGE_TTL_MS) return;
    this.refreshInBackground(conversationId);
  }

  /**
   * Delta-reconcile after a reconnect. Only patches gaps — anything already
   * confirmed stays put, so the view does not jump.
   */
  async reconcile(conversationId) {
    const current = this.messages.get(conversationId) ?? [];
    const confirmed = current.filter((m) => !String(m.id).startsWith('temp-'));
    if (!confirmed.length) return;

    const latest = confirmed[confirmed.length - 1];
    try {
      const delta = await fetchMessagesSince(conversationId, latest.createdAt);
      if (!delta.length) return;
      this.messages.set(conversationId, merge([...confirmed, ...delta], current));
      this.emitThread(conversationId);
    } catch { /* non-critical */ }
  }

  reconcileAll() {
    Array.from(this.messages.keys()).forEach((id, i) => {
      // Staggered so a reconnect does not fire N simultaneous queries.
      setTimeout(() => this.reconcile(id).catch(() => {}), i * 80);
    });
  }

  /**
   * Write an incoming or optimistic message into the cache.
   *
   * Dedup order matches the app:
   *   1. replace the matching optimistic (temp-*) bubble by clientId
   *   2. skip if the server id is already present
   *   3. otherwise append and re-sort
   */
  injectMessage(conversationId, message) {
    const current = this.messages.get(conversationId) ?? [];

    if (message.clientId) {
      const tempIdx = current.findIndex(
        (m) => String(m.id).startsWith('temp-') && m.clientId === message.clientId);
      if (tempIdx !== -1) {
        const updated = [...current];
        updated[tempIdx] = message;
        this.messages.set(conversationId, updated);
        this.emitThread(conversationId);
        return;
      }
    }

    if (current.some((m) => m.id === message.id)) return;

    this.messages.set(conversationId, [...current, message].sort(byCreatedAt));
    this.emitThread(conversationId);
  }

  /** Drop an optimistic bubble whose send failed. */
  removeMessage(conversationId, messageId) {
    const current = this.messages.get(conversationId) ?? [];
    this.messages.set(conversationId, current.filter((m) => m.id !== messageId));
    this.emitThread(conversationId);
  }

  /** Patch an optimistic bubble in place (upload progress → uploaded). */
  patchMessage(conversationId, messageId, patch) {
    const current = this.messages.get(conversationId) ?? [];
    this.messages.set(conversationId, current.map((m) =>
      m.id === messageId ? { ...m, ...patch, metadata: { ...m.metadata, ...patch.metadata } } : m));
    this.emitThread(conversationId);
  }

  /**
   * Send a message. The optimistic bubble is written first so the composer
   * feels instant; the server row replaces it by clientId on return, or via
   * the realtime INSERT if that arrives first — either way, never both.
   */
  async send(conversationId, text, options = {}) {
    const senderId = this.userId;
    if (!senderId) throw new Error('Not signed in');

    const clientId = options.clientId ?? newClientId(options.type ?? 'text');
    const message = await insertMessage(conversationId, senderId, text, { ...options, clientId });

    this.injectMessage(conversationId, message);
    this.patchFromMessage(conversationId, message, false);
    return message;
  }

  /** Search the loaded threads. Only covers what is in memory, as the app does. */
  search(query) {
    const results = new Map();
    const q = query.trim().toLowerCase();
    if (!q) return results;

    for (const [conversationId, messages] of this.messages.entries()) {
      const matches = messages.filter((m) => m.text?.toLowerCase().includes(q));
      if (matches.length) {
        results.set(conversationId, { match: matches[matches.length - 1], count: matches.length });
      }
    }
    return results;
  }

  reset() {
    this.userId = null;
    this.conversations = null;
    this.messages.clear();
    this.fetchedAt.clear();
    this.inFlight.clear();
    this.profiles.clear();
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════════════════ */

const byCreatedAt = (a, b) => new Date(a.createdAt) - new Date(b.createdAt);

/**
 * Merge server messages over cached ones. Server wins per id; optimistic
 * bubbles survive unless their clientId has been confirmed, so nothing
 * flickers out and back during a background refresh.
 */
function merge(server, cached) {
  const byId = new Map();
  const confirmedClientIds = new Set();

  server.forEach((m) => {
    byId.set(m.id, m);
    if (m.clientId) confirmedClientIds.add(m.clientId);
  });

  cached.forEach((m) => {
    if (!String(m.id).startsWith('temp-')) return;
    if (m.clientId && confirmedClientIds.has(m.clientId)) return;
    byId.set(m.id, m);
  });

  return Array.from(byId.values()).sort(byCreatedAt);
}

/** Inbox preview straight off a conversation row (no full message to hand). */
function previewForRow(row) {
  switch (row.lastMessageType) {
    case 'image': return 'Photo';
    case 'voice': return 'Voice note';
    case 'location': return 'Location';
    case 'contact': return 'Contact';
    case 'music': return 'Music';
    case 'plan': return 'Shared a plan';
    case 'dark_room_invite': return 'Dark Room invite';
    default: return row.lastMessage || '';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value) => UUID_RE.test(String(value ?? ''));

/** Idempotency key for a send. Prefixed by type purely to aid debugging. */
export function newClientId(kind = 'msg') {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newTempId(kind = 'msg') {
  return `temp-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const store = new MessageStore();
