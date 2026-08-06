/**
 * Meetfleet — web messaging: realtime.
 *
 * A browser port of the messaging half of mobile/context/RealtimeContext.tsx
 * plus mobile/services/typing.ts.
 *
 * The `messages` INSERT subscription has NO server-side filter — Supabase
 * realtime cannot express "conversations I am a participant in" — so every
 * insert in the project reaches every client and is discarded here. The app
 * does the same, and the checks below mirror its order exactly:
 *
 *   own message               → inject (confirms an optimistic bubble)
 *   known conversation        → inject
 *   otherwise                 → ask is_conversation_participant, then inject
 *
 * Skipping that last RPC would leak other people's message text into memory,
 * so it is not an optimisation worth making.
 */

import { supabase, ensureSession, invalidateSession } from './supabase.js';
import { mapMessage, store } from './service.js';

let messageChannel = null;
let currentUserId = null;

const incomingListeners = new Set();
const connectionListeners = new Set();

/** Notified for every message accepted into the store. */
export function onIncoming(fn) {
  incomingListeners.add(fn);
  return () => incomingListeners.delete(fn);
}

/** Notified with 'connected' | 'reconnecting' | 'offline'. */
export function onConnection(fn) {
  connectionListeners.add(fn);
  return () => connectionListeners.delete(fn);
}

function emitConnection(status) {
  connectionListeners.forEach((fn) => fn(status));
}

/**
 * The conversation currently on screen. Messages for it are never counted as
 * unread, matching the app's activeConversationIdRef.
 */
let activeConversationId = null;
export function setActiveConversation(id) {
  activeConversationId = id;
}

export function subscribeToMessages(userId) {
  if (messageChannel) return;
  currentUserId = userId;

  messageChannel = supabase
    .channel('web-messages-v1')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      async (payload) => {
        const row = payload.new;
        const conversationId = row.conversation_id ?? row.conversationId ?? '';
        const senderId = row.sender_id ?? row.senderId ?? '';
        if (!conversationId) return;

        const isOwn = senderId === currentUserId;
        const isKnown = store.isKnownConversation(conversationId);
        const isActive = activeConversationId === conversationId;

        // An unknown conversation from someone else has to be authorised
        // before its content is allowed into memory.
        if (!isOwn && !isKnown && !isActive) {
          try {
            const { data: isParticipant } = await supabase
              .rpc('is_conversation_participant', {
                conversation_uuid: conversationId,
                user_uuid: currentUserId,
              });
            if (!isParticipant) return;
          } catch {
            return;
          }
          // A new thread — pull it into the inbox.
          store.loadConversations(currentUserId).catch(() => {});
        }

        const message = mapMessage(row);
        store.injectMessage(conversationId, message);
        store.patchFromMessage(conversationId, message, !isOwn && !isActive);

        incomingListeners.forEach((fn) => fn(message, { isOwn, isActive }));
      },
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        emitConnection('connected');
        // A resubscribe means we were away; patch whatever was missed.
        store.reconcileAll();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        emitConnection('reconnecting');
      } else if (status === 'CLOSED') {
        emitConnection('offline');
      }
    });
}

export function unsubscribeFromMessages() {
  if (!messageChannel) return;
  supabase.removeChannel(messageChannel);
  messageChannel = null;
  currentUserId = null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Typing — broadcast, mirroring mobile/services/typing.ts

   One channel per conversation, `self: false` so a client never sees its own
   events. Sends are throttled to one per 2s and the indicator self-clears
   after 3s, so a partner who closes the tab mid-sentence does not leave a
   permanent "typing…".
   ═══════════════════════════════════════════════════════════════════════════ */

const typingEntries = new Map();
const lastBroadcastAt = new Map();

export function subscribeToTyping(conversationId, myUserId, onTyping) {
  if (!typingEntries.has(conversationId)) {
    const channel = supabase.channel(`typing:${conversationId}`, {
      config: { broadcast: { self: false } },
    });

    const entry = { channel, listeners: new Set(), timeout: null, myUserId };
    typingEntries.set(conversationId, entry);

    channel
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        const current = typingEntries.get(conversationId);
        if (!current || payload?.userId === current.myUserId) return;

        if (current.timeout) clearTimeout(current.timeout);
        current.listeners.forEach((fn) => fn(true));
        current.timeout = setTimeout(() => {
          const latest = typingEntries.get(conversationId);
          if (!latest) return;
          latest.listeners.forEach((fn) => fn(false));
          latest.timeout = null;
        }, 3000);
      })
      .subscribe();
  }

  const entry = typingEntries.get(conversationId);
  entry.listeners.add(onTyping);

  return () => {
    const current = typingEntries.get(conversationId);
    if (!current) return;
    current.listeners.delete(onTyping);
    if (current.listeners.size === 0) {
      if (current.timeout) clearTimeout(current.timeout);
      supabase.removeChannel(current.channel);
      typingEntries.delete(conversationId);
    }
  };
}

export function broadcastTyping(conversationId, userId) {
  const key = `${conversationId}:${userId}`;
  const now = Date.now();
  if (now - (lastBroadcastAt.get(key) ?? 0) < 2000) return;
  lastBroadcastAt.set(key, now);

  typingEntries.get(conversationId)?.channel.send({
    type: 'broadcast',
    event: 'typing',
    payload: { userId, conversationId },
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Network awareness

   The websocket does not always notice a dropped connection promptly, so the
   browser's own online/offline events drive a reconcile as well.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Bring the session back before re-reading.
 *
 * get-auth-token mints a short-lived access token with no refresh token behind
 * it, so a tab left open past its expiry holds a dead credential and every
 * query 401s. A gap in connectivity is exactly when that is most likely to
 * have happened, so the token is re-minted before the catch-up reads rather
 * than after they have already failed.
 */
async function resumeAfterGap() {
  invalidateSession();
  await ensureSession();
  store.reconcileAll();
  if (currentUserId) store.loadConversations(currentUserId).catch(() => {});
}

export function watchConnectivity() {
  window.addEventListener('online', () => {
    emitConnection('reconnecting');
    resumeAfterGap();
  });

  window.addEventListener('offline', () => emitConnection('offline'));

  // Returning to a backgrounded tab is the other common way to miss messages.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    resumeAfterGap();
  });
}
