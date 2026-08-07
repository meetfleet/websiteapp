/**
 * Meetfleet — web messaging: UI.
 *
 * The desktop client for the conversations that already exist in the app. It
 * reads and writes the same Supabase tables, so anything sent here appears on
 * the phone immediately and vice versa.
 *
 * Deliberate scope limit: only text, photo, video, voice notes, contacts and
 * locations render natively. Plans, shared music and Dark Room invites are
 * live interactive surfaces that only the app can drive, so they get a single
 * honest "open the app" bubble instead of a static imitation — see
 * renderAppOnly(). The composer offers only what this surface can honestly
 * produce: text, photo, video, voice note.
 */

import {
  getMe, requireAuth, signOut, ensureSession, getStoredUser,
} from './supabase.js';
import {
  store, isAppOnly, newClientId, newTempId, resolveTier,
} from './service.js';
import {
  subscribeToMessages, unsubscribeFromMessages, setActiveConversation,
  subscribeToTyping, broadcastTyping, onIncoming, onConnection, watchConnectivity,
} from './realtime.js';
import {
  uploadImage, uploadVideo, uploadVoiceNote, publicUrlFor, VoiceRecorder,
} from './media.js';

/* ═══════════════════════════════════════════════════════════════════════════
   DOM helpers
   ═══════════════════════════════════════════════════════════════════════════ */

const $ = (sel) => document.querySelector(sel);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/** Build an inline SVG icon from a path list, avoiding innerHTML for content. */
function icon(paths, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  paths.forEach((d) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  });
  return svg;
}

const ICONS = {
  play: ['M6 3l14 9-14 9z'],
  pause: ['M7 4h3v16H7z', 'M14 4h3v16h-3z'],
  pin: ['M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z', 'M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
  phone: ['M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.2 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z'],
  sparkle: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z'],
};

let toastTimer = null;
function toast(message) {
  const node = $('#toast');
  $('#toast-text').textContent = message;
  node.classList.add('is-open');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-open'), 3600);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Formatting
   ═══════════════════════════════════════════════════════════════════════════ */

const timeOf = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Relative stamp for the inbox: time today, weekday this week, date beyond. */
function inboxStamp(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();
  const days = Math.floor((startOfDay(now) - startOfDay(date)) / 86400000);

  if (days === 0) return timeOf(iso);
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Mirrors formatDateSeparator() in mobile/app/messages/[id].tsx. */
function dateSeparatorLabel(iso) {
  const date = new Date(iso);
  const now = new Date();
  const days = Math.floor((startOfDay(now) - startOfDay(date)) / 86400000);

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'long' });
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { month: 'long', day: 'numeric' });
  }
  return date.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const sameDay = (a, b) => startOfDay(new Date(a)) === startOfDay(new Date(b));

function formatDuration(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const initialsOf = (name) => String(name || '?')
  .split(/\s+/).map((word) => word[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

/* ═══════════════════════════════════════════════════════════════════════════
   App state
   ═══════════════════════════════════════════════════════════════════════════ */

const state = {
  me: null,
  activeId: null,
  conversations: [],
  filter: '',
  partnerLastReadAt: null,
  partnerTyping: false,
  unsubTyping: null,
  unsubThread: null,
};

/* ═══════════════════════════════════════════════════════════════════════════
   Conversation list
   ═══════════════════════════════════════════════════════════════════════════ */

function renderConversations() {
  const list = $('#conversation-list');
  const query = state.filter.trim().toLowerCase();

  // Search spans both the conversation name and the message bodies already in
  // memory, so "pizza" finds the thread it was said in, not just the person.
  const textMatches = query ? store.search(query) : null;
  const visible = state.conversations.filter((convo) => {
    if (!query) return true;
    return convo.displayName.toLowerCase().includes(query)
      || convo.name.toLowerCase().includes(query)
      || (convo.lastMessage ?? '').toLowerCase().includes(query)
      || textMatches?.has(convo.id);
  });

  list.replaceChildren();

  if (!visible.length) {
    $('#list-empty').classList.remove('is-hidden');
    $('#list-empty').querySelector('.empty-title').textContent =
      query ? 'No matches' : 'No conversations yet';
    $('#list-empty').querySelector('.empty-body').textContent = query
      ? 'Try a different name or word.'
      : 'Start a chat in the Meetfleet app and it will show up here.';
    return;
  }
  $('#list-empty').classList.add('is-hidden');

  visible.forEach((convo) => list.appendChild(conversationRow(convo, textMatches)));
}

function conversationRow(convo, textMatches) {
  const row = el('button', 'convo');
  row.type = 'button';
  row.setAttribute('role', 'listitem');
  row.dataset.id = convo.id;
  if (convo.id === state.activeId) row.classList.add('is-active');
  if ((convo.unreadCount ?? 0) > 0) row.classList.add('is-unread');

  const avatar = el('div', 'convo-avatar');
  if (convo.avatarUrl) {
    const img = el('img');
    img.src = convo.avatarUrl;
    img.alt = '';
    img.loading = 'lazy';
    // A dead avatar URL should degrade to initials, not a broken-image glyph.
    img.addEventListener('error', () => {
      img.replaceWith(fallbackAvatar(convo.displayName, convo.emoji));
    }, { once: true });
    avatar.appendChild(img);
  } else {
    avatar.appendChild(fallbackAvatar(convo.displayName, convo.emoji));
  }

  const body = el('div', 'convo-body');
  body.appendChild(el('p', 'convo-name', convo.displayName));

  // When the match came from message text rather than the name, show that
  // message — otherwise the row looks unrelated to what was searched.
  const hit = textMatches?.get(convo.id);
  body.appendChild(el('p', 'convo-preview', hit ? hit.match.text : (convo.lastMessage || 'Open to view')));

  const side = el('div', 'convo-side');
  side.appendChild(el('span', 'convo-time', inboxStamp(convo.updatedAt)));
  if ((convo.unreadCount ?? 0) > 0) {
    side.appendChild(el('span', 'convo-badge', String(Math.min(convo.unreadCount, 99))));
  }

  row.append(avatar, body, side);
  row.addEventListener('click', () => openConversation(convo.id));
  return row;
}

function fallbackAvatar(name, emoji) {
  return el('span', 'fallback', emoji || initialsOf(name));
}

/* ═══════════════════════════════════════════════════════════════════════════
   Thread rendering
   ═══════════════════════════════════════════════════════════════════════════ */

function renderThread(messages) {
  const thread = $('#thread');

  // Preserve "was the user reading the latest?" across the repaint — jumping
  // someone to the bottom while they scroll back through history is hostile.
  const wasAtBottom = isNearBottom(thread);

  thread.replaceChildren();

  messages.forEach((message, i) => {
    const previous = messages[i - 1];
    const next = messages[i + 1];

    if (!previous || !sameDay(previous.createdAt, message.createdAt)) {
      thread.appendChild(el('div', 'date-sep', dateSeparatorLabel(message.createdAt)));
    }

    if (message.type === 'system') {
      thread.appendChild(el('div', 'system-pill', message.text));
      return;
    }

    const isMe = message.senderId === state.me.id;
    const sameSpeakerBefore = previous
      && previous.senderId === message.senderId
      && previous.type !== 'system'
      && sameDay(previous.createdAt, message.createdAt);
    const sameSpeakerAfter = next
      && next.senderId === message.senderId
      && next.type !== 'system'
      && sameDay(next.createdAt, message.createdAt);

    thread.appendChild(messageRow(message, {
      isMe,
      isGroupStart: !sameSpeakerBefore,
      isGroupEnd: !sameSpeakerAfter,
      isLast: i === messages.length - 1,
    }));
  });

  if (state.partnerTyping) thread.appendChild(typingIndicator());

  if (wasAtBottom) scrollToBottom(thread);
}

function typingIndicator() {
  const node = el('div', 'typing');
  node.append(el('i'), el('i'), el('i'));
  return node;
}

function messageRow(message, { isMe, isGroupStart, isGroupEnd, isLast }) {
  const row = el('div', `row ${isMe ? 'from-me' : 'from-them'}`);
  if (isGroupStart) row.classList.add('is-group-start');
  if (isGroupEnd) row.classList.add('is-group-end');

  // Their avatar appears once per run, on the last bubble, so a long reply
  // is not a column of repeated faces.
  if (!isMe) {
    if (isGroupEnd) {
      const convo = store.getConversation(state.activeId);
      const img = el('img', 'row-avatar');
      img.src = convo?.avatarUrl || '';
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => img.remove(), { once: true });
      row.appendChild(img);
    } else {
      row.appendChild(el('div', 'row-avatar-spacer'));
    }
  }

  const stack = el('div', 'row-stack');
  stack.appendChild(renderBody(message, isMe));

  // One stamp per group, on the closing bubble — the app does the same.
  if (isGroupEnd) {
    const meta = el('div', 'bubble-time');
    meta.appendChild(el('span', null, timeOf(message.createdAt)));

    if (message.metadata?.uploading) {
      meta.appendChild(el('span', null, 'Sending…'));
    } else if (isMe && isLast && state.partnerLastReadAt
      && new Date(state.partnerLastReadAt) >= new Date(message.createdAt)) {
      meta.appendChild(el('span', 'receipt', 'Seen'));
    }
    stack.appendChild(meta);
  }

  if (message.metadata?.uploading) stack.classList.add('bubble-pending');

  row.appendChild(stack);
  return row;
}

/** Dispatch on message type — the web-renderable set, then the app-only fallback. */
function renderBody(message, isMe) {
  if (isAppOnly(message)) return renderAppOnly(message);

  switch (message.type) {
    case 'image':    return renderMedia(message);
    case 'voice':    return renderVoice(message, isMe);
    case 'contact':  return renderContact(message);
    case 'location': return renderLocation(message);
    default:         return renderText(message);
  }
}

/**
 * Text, with bare URLs turned into links.
 *
 * Built by splitting on a URL pattern and appending real nodes — never
 * innerHTML, because message text is attacker-controlled and one unescaped
 * bubble would be a stored XSS across every reader of the thread.
 */
function renderText(message) {
  const bubble = el('div', 'bubble');
  const parts = String(message.text ?? '').split(/(https?:\/\/[^\s]+)/g);

  parts.forEach((part) => {
    if (/^https?:\/\/[^\s]+$/.test(part)) {
      const link = el('a', null, part);
      link.href = part;
      link.target = '_blank';
      // noopener: the opened page must not get a handle on this tab.
      link.rel = 'noopener noreferrer nofollow';
      bubble.appendChild(link);
    } else if (part) {
      bubble.appendChild(document.createTextNode(part));
    }
  });

  return bubble;
}

/** Photo or video. Video is type 'image' with metadata.kind === 'video'. */
function renderMedia(message) {
  const meta = message.metadata ?? {};
  const wrap = el('div', 'bubble bubble-media');
  const isVideo = meta.kind === 'video';
  const url = meta.imageUrl || meta.url || message.text;

  if (meta.uploading) {
    wrap.classList.add('is-uploading');
    const spinner = el('div', 'upload-spinner');
    spinner.appendChild(el('span'));
    wrap.appendChild(spinner);
  }

  if (isVideo) {
    const poster = el('img');
    poster.src = meta.posterUrl || meta.previewUrl || '';
    poster.alt = 'Video';
    poster.loading = 'lazy';
    if (meta.width && meta.height) {
      poster.width = meta.width;
      poster.height = meta.height;
    }
    wrap.appendChild(poster);

    const play = el('div', 'media-play');
    const badge = el('span');
    badge.appendChild(icon(ICONS.play, 22));
    play.appendChild(badge);
    wrap.appendChild(play);

    if (url && !meta.uploading) {
      wrap.addEventListener('click', () => openViewer(url, 'video'));
    }
  } else {
    const img = el('img');
    img.src = url || '';
    img.alt = 'Photo';
    img.loading = 'lazy';
    // Intrinsic size reserves the right box before the bytes land, so the
    // thread does not jolt as images decode.
    if (meta.width && meta.height) {
      img.width = meta.width;
      img.height = meta.height;
    }
    wrap.appendChild(img);

    if (url && !meta.uploading) {
      wrap.addEventListener('click', () => openViewer(url, 'image'));
    }
  }

  return wrap;
}

/**
 * Voice note. Playback is a plain <audio> driven by the bar strip; only one
 * note plays at a time, since two overlapping voices are never intended.
 */
let activeAudio = null;

function renderVoice(message, isMe) {
  const meta = message.metadata ?? {};
  const wrap = el('div', 'voice');
  const durationMs = meta.durationMs || 0;

  const playBtn = el('button', 'voice-play');
  playBtn.type = 'button';
  playBtn.setAttribute('aria-label', 'Play voice note');
  playBtn.appendChild(icon(ICONS.play, 15));

  const wave = el('div', 'voice-wave');
  const bars = (Array.isArray(meta.waveform) && meta.waveform.length >= 4)
    ? meta.waveform
    // A note recorded before waveforms existed still needs a shape to show.
    : Array.from({ length: 32 }, (_, i) => 0.25 + Math.abs(Math.sin(i * 0.9)) * 0.55);

  bars.forEach((value) => {
    const bar = el('i');
    bar.style.height = `${Math.max(12, Math.min(100, value * 100))}%`;
    wave.appendChild(bar);
  });

  const timeLabel = el('span', 'voice-time', formatDuration(durationMs));

  wrap.append(playBtn, wave, timeLabel);

  if (meta.uploading) {
    playBtn.disabled = true;
    timeLabel.textContent = 'Sending…';
    return wrap;
  }

  const src = publicUrlFor(meta.storagePath || meta.url || message.text);
  if (!src) return wrap;

  let audio = null;

  const paintProgress = (ratio) => {
    const played = Math.round(ratio * bars.length);
    Array.from(wave.children).forEach((bar, i) => {
      bar.classList.toggle('is-played', i < played);
    });
  };

  const reset = () => {
    playBtn.replaceChildren(icon(ICONS.play, 15));
    timeLabel.textContent = formatDuration(durationMs);
    paintProgress(0);
  };

  playBtn.addEventListener('click', () => {
    if (!audio) {
      audio = new Audio(src);
      audio.preload = 'metadata';
      audio.addEventListener('timeupdate', () => {
        // Prefer the file's own duration once known: the recorded value is a
        // wall-clock estimate and drifts from the encoded length.
        const total = Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration * 1000
          : durationMs;
        timeLabel.textContent = formatDuration(audio.currentTime * 1000);
        paintProgress(total ? (audio.currentTime * 1000) / total : 0);
      });
      audio.addEventListener('ended', () => { activeAudio = null; reset(); });
      audio.addEventListener('error', () => {
        toast('Could not play that voice note.');
        activeAudio = null;
        reset();
      });
    }

    if (!audio.paused) {
      audio.pause();
      activeAudio = null;
      playBtn.replaceChildren(icon(ICONS.play, 15));
      return;
    }

    if (activeAudio && activeAudio !== audio) activeAudio.pause();
    activeAudio = audio;
    audio.play().catch(() => toast('Could not play that voice note.'));
    playBtn.replaceChildren(icon(ICONS.pause, 15));
  });

  // Scrub by clicking anywhere on the bars.
  wave.addEventListener('click', (event) => {
    if (!audio || !Number.isFinite(audio.duration)) return;
    const rect = wave.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
  });

  return wrap;
}

function renderContact(message) {
  const meta = message.metadata ?? {};
  const name = meta.name || message.text || 'Contact';
  const detail = meta.phone || meta.email || '';

  const card = el('div', 'card-bubble');
  const row = el('div', 'contact-row');
  row.appendChild(el('span', 'contact-initials', initialsOf(name)));

  const info = el('div', 'contact-info');
  info.appendChild(el('p', 'contact-name', name));
  if (detail) info.appendChild(el('p', 'contact-detail', detail));
  row.appendChild(info);

  card.appendChild(row);
  return card;
}

/**
 * Location. Rendered as a labelled card that opens the coordinates in the
 * viewer's own map app — no map tiles are fetched, since that would need a
 * Mapbox token in a page any signed-in user can read.
 */
function renderLocation(message) {
  const coords = message.locationCoords ?? {};
  const card = el('div', 'card-bubble');

  const label = el('div', 'location-label');
  label.appendChild(icon(ICONS.pin, 15));
  label.appendChild(el('span', null, message.text || 'Shared a location'));
  card.appendChild(label);

  if (Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => {
      window.open(`https://www.google.com/maps?q=${coords.lat},${coords.lng}`,
        '_blank', 'noopener,noreferrer');
    });
  }

  return card;
}

/**
 * Plans, shared music and Dark Room invites.
 *
 * Each is a live surface in the app — a plan has RSVP state, music has
 * playback, a Dark Room is a synchronised session. Rendering a frozen visual
 * copy here would imply an interaction this page cannot honour, so it says so
 * plainly instead and names what the message is.
 */
const APP_ONLY_COPY = {
  plan: {
    title: (m) => m.metadata?.planTitle || 'Shared a plan',
    body: 'Open the Meetfleet app to view this plan and RSVP.',
  },
  music: {
    title: (m) => {
      const track = m.metadata?.trackName;
      const artist = m.metadata?.artistName;
      return track ? (artist ? `${track} · ${artist}` : track) : 'Shared a song';
    },
    body: 'Open the Meetfleet app to listen.',
  },
  dark_room_invite: {
    title: () => 'Dark Room invite',
    body: 'Open the Meetfleet app to join the room.',
  },
};

function renderAppOnly(message) {
  const copy = APP_ONLY_COPY[message.type] ?? {
    title: () => 'Message from the app',
    body: 'Open the Meetfleet app to view this message.',
  };

  const wrap = el('div', 'app-only');

  const badge = el('div', 'app-only-icon');
  badge.appendChild(icon(ICONS.sparkle, 17));
  wrap.appendChild(badge);

  const body = el('div');
  body.appendChild(el('p', 'app-only-title', copy.title(message)));
  body.appendChild(el('p', 'app-only-body', copy.body));
  wrap.appendChild(body);

  return wrap;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Scroll
   ═══════════════════════════════════════════════════════════════════════════ */

/** Within ~140px of the end counts as "reading the latest". */
function isNearBottom(node) {
  if (!node.scrollHeight) return true;
  return node.scrollHeight - node.scrollTop - node.clientHeight < 140;
}

function scrollToBottom(node, smooth = false) {
  node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Viewer
   ═══════════════════════════════════════════════════════════════════════════ */

function openViewer(url, kind) {
  const stage = $('#viewer-stage');
  stage.replaceChildren();

  if (kind === 'video') {
    const video = el('video');
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    stage.appendChild(video);
  } else {
    const img = el('img');
    img.src = url;
    img.alt = '';
    stage.appendChild(img);
  }

  $('#viewer').hidden = false;
}

function closeViewer() {
  $('#viewer').hidden = true;
  // Stop playback and release the buffer — a hidden <video> keeps decoding.
  $('#viewer-stage').replaceChildren();
}

$('#viewer-close').addEventListener('click', closeViewer);
$('#viewer').addEventListener('click', (event) => {
  if (event.target === $('#viewer')) closeViewer();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#viewer').hidden) closeViewer();
});

/* ═══════════════════════════════════════════════════════════════════════════
   Opening a conversation
   ═══════════════════════════════════════════════════════════════════════════ */

async function openConversation(conversationId) {
  if (state.activeId === conversationId) return;

  // Tear down whatever the previous thread had running.
  state.unsubTyping?.();
  state.unsubThread?.();
  state.partnerTyping = false;
  state.partnerLastReadAt = null;

  state.activeId = conversationId;
  setActiveConversation(conversationId);
  location.hash = conversationId;

  const convo = store.getConversation(conversationId);
  $('#chat-empty').classList.add('is-hidden');
  $('#chat').classList.remove('is-hidden');
  $('#app').dataset.view = 'thread';

  $('#chat-name').textContent = convo?.displayName ?? 'Chat';
  $('#chat-meta').textContent = '';
  const avatar = $('#chat-avatar');
  avatar.src = convo?.avatarUrl || '';
  avatar.alt = '';
  // Never leave the previous partner's card on screen.
  closePeek();

  renderConversations();

  // Paint the cache immediately, then let loadMessages decide whether the
  // network is needed. An already-warm thread never shows a loading state.
  const cached = store.cached(conversationId);
  if (cached.length) renderThread(cached);

  state.unsubThread = store.onThread(conversationId, (messages) => {
    if (state.activeId !== conversationId) return;
    renderThread(messages);
  });

  try {
    const messages = await store.loadMessages(conversationId);
    if (state.activeId !== conversationId) return;
    renderThread(messages);
    scrollToBottom($('#thread'));
  } catch (err) {
    console.error('Failed to load messages:', err);
    toast('Could not load that conversation.');
  }

  store.markRead(conversationId).catch(() => {});

  store.partnerLastReadAt(conversationId).then((readAt) => {
    if (state.activeId !== conversationId) return;
    state.partnerLastReadAt = readAt;
    renderThread(store.cached(conversationId));
  });

  state.unsubTyping = subscribeToTyping(conversationId, state.me.id, (isTyping) => {
    if (state.activeId !== conversationId) return;
    state.partnerTyping = isTyping;
    $('#chat-meta').textContent = isTyping ? 'typing…' : '';
    renderThread(store.cached(conversationId));
  });
}

$('#btn-back').addEventListener('click', () => {
  $('#app').dataset.view = 'list';
});

/* ═══════════════════════════════════════════════════════════════════════════
   Composer
   ═══════════════════════════════════════════════════════════════════════════ */

const input = $('#composer-input');

/** Grow the textarea with its content, up to the CSS max-height. */
function autoGrow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
}

/** Mic when there is nothing to send, send button once there is. */
function refreshComposerButtons() {
  const hasText = input.value.trim().length > 0;
  $('#btn-send').classList.toggle('is-hidden', !hasText);
  $('#btn-mic').classList.toggle('is-hidden', hasText);
}

input.addEventListener('input', () => {
  autoGrow();
  refreshComposerButtons();
  if (state.activeId) broadcastTyping(state.activeId, state.me.id);
});

input.addEventListener('keydown', (event) => {
  // Enter sends; Shift+Enter is a newline — the convention every chat client
  // on a keyboard uses.
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendText();
  }
});

$('#btn-send').addEventListener('click', sendText);

async function sendText() {
  const text = input.value.trim();
  if (!text || !state.activeId) return;

  const conversationId = state.activeId;
  const clientId = newClientId('text');
  const tempId = newTempId('text');

  // Optimistic bubble first — the composer must never feel like it is waiting
  // on a round-trip. injectMessage() replaces this by clientId on confirm.
  store.injectMessage(conversationId, {
    id: tempId,
    clientId,
    conversationId,
    senderId: state.me.id,
    text,
    type: 'text',
    createdAt: new Date().toISOString(),
    metadata: {},
  });

  input.value = '';
  autoGrow();
  refreshComposerButtons();
  scrollToBottom($('#thread'), true);

  try {
    await store.send(conversationId, text, { type: 'text', clientId });
  } catch (err) {
    console.error('Send failed:', err);
    store.removeMessage(conversationId, tempId);
    // Give the text back rather than losing what they typed.
    input.value = text;
    autoGrow();
    refreshComposerButtons();
    toast('Could not send that message.');
  }
}

/* ── Attachments ─────────────────────────────────────────────────────────── */

/* ── Profile peek ────────────────────────────────────────────────────────── */
/*
 * Tapping the header avatar or name opens a small card with the partner's
 * generated avatar, name, @username and subscription tier.
 */
const peek = $('#peek');
const btnPeek = $('#btn-peek');
let peekOpen = false;

const TIER_LABELS = {
  free: 'Free',
  basics: 'Basics',
  gold: 'Gold',
  onyx: 'Onyx',
};

function openPeek() {
  const convo = store.getConversation(state.activeId);
  if (!convo) return;

  // The card shows the generated avatar specifically — falling back to the
  // uploaded photo only when the user has no dicebear one.
  $('#peek-avatar').src = convo.dicebearAvatar || convo.avatarUrl || '';
  $('#peek-avatar').alt = '';
  $('#peek-name').textContent = convo.displayName || 'Chat';

  const username = $('#peek-username');
  username.textContent = convo.username ? `@${convo.username}` : '';
  username.hidden = !convo.username;

  const tier = resolveTier(convo);
  const badge = $('#peek-tier');
  badge.textContent = TIER_LABELS[tier] ?? 'Free';
  badge.dataset.tier = tier;

  peek.hidden = false;
  peekOpen = true;
  btnPeek.setAttribute('aria-expanded', 'true');
}

function closePeek() {
  if (!peekOpen) return;
  peek.hidden = true;
  peekOpen = false;
  btnPeek.setAttribute('aria-expanded', 'false');
}

btnPeek.addEventListener('click', (event) => {
  event.stopPropagation();
  if (peekOpen) closePeek();
  else openPeek();
});

// Click anywhere else, or Escape, dismisses it.
document.addEventListener('click', (event) => {
  if (peekOpen && !peek.contains(event.target)) closePeek();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && peekOpen) closePeek();
});

/* ── Attachment menu ─────────────────────────────────────────────────────── */
/*
 * Desktop port of the app's chat FloatingMenu. The flight, stagger and blur
 * live in CSS; this only anchors the panel to the plus button, toggles the
 * open class, and routes the five actions.
 *
 * Gallery and Camera map onto the two file inputs. Location, Contact and Music
 * exist in the app but have no web equivalent yet, so they say so rather than
 * silently doing nothing.
 */
const fmenu = $('#fmenu');
const fmenuPanel = $('#fmenu-panel');
const btnAttach = $('#btn-attach');
let fmenuOpen = false;
let fmenuCloseTimer = null;

function positionFloatingMenu() {
  const rect = btnAttach.getBoundingClientRect();
  // Panel grows upward from just above the plus button, left edges aligned.
  fmenuPanel.style.left = `${rect.left}px`;
  fmenuPanel.style.bottom = `${window.innerHeight - rect.top + 6}px`;
}

function openFloatingMenu() {
  if (fmenuOpen) return;
  clearTimeout(fmenuCloseTimer);
  fmenuOpen = true;
  fmenu.hidden = false;
  positionFloatingMenu();
  // One frame with the menu laid out but not yet open, so the transition runs.
  requestAnimationFrame(() => fmenu.classList.add('is-open'));
  btnAttach.classList.add('is-active');
  $('#composer').classList.add('is-menu-open');
  btnAttach.setAttribute('aria-expanded', 'true');
}

function closeFloatingMenu() {
  if (!fmenuOpen) return;
  fmenuOpen = false;
  fmenu.classList.remove('is-open');
  btnAttach.classList.remove('is-active');
  btnAttach.setAttribute('aria-expanded', 'false');
  // Hide only once the fly-back has finished, matching the app's unmount delay.
  fmenuCloseTimer = setTimeout(() => {
    fmenu.hidden = true;
    $('#composer').classList.remove('is-menu-open');
  }, 420);
}

btnAttach.setAttribute('aria-haspopup', 'true');
btnAttach.setAttribute('aria-expanded', 'false');

btnAttach.addEventListener('click', () => {
  if (fmenuOpen) closeFloatingMenu();
  else openFloatingMenu();
});

$('#fmenu-backdrop').addEventListener('click', closeFloatingMenu);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && fmenuOpen) closeFloatingMenu();
});

window.addEventListener('resize', () => {
  if (fmenuOpen) positionFloatingMenu();
});

const FMENU_ACTIONS = {
  gallery: () => $('#file-input').click(),
  camera: () => $('#camera-input').click(),
  location: () => toast('Sharing your location is only available in the app.'),
  contact: () => toast('Sharing a contact is only available in the app.'),
  music: () => toast('Sending music is only available in the app.'),
};

fmenuPanel.addEventListener('click', (event) => {
  const item = event.target.closest('.fmenu-item');
  if (!item) return;
  const run = FMENU_ACTIONS[item.dataset.action];
  closeFloatingMenu();
  // Let the menu fly back before the picker steals focus, as the app does.
  if (run) setTimeout(run, 260);
});

$('#camera-input').addEventListener('change', async (event) => {
  const files = Array.from(event.target.files ?? []);
  event.target.value = '';
  for (const file of files) await sendAttachment(file);
});

$('#file-input').addEventListener('change', async (event) => {
  const files = Array.from(event.target.files ?? []);
  // Reset immediately so picking the same file twice still fires a change.
  event.target.value = '';
  for (const file of files) await sendAttachment(file);
});

// Drag a photo or video onto the thread to send it.
const chatPane = $('#chat-pane');
['dragenter', 'dragover'].forEach((type) => {
  chatPane.addEventListener(type, (event) => {
    if (!state.activeId) return;
    event.preventDefault();
  });
});

chatPane.addEventListener('drop', async (event) => {
  if (!state.activeId) return;
  event.preventDefault();
  const files = Array.from(event.dataTransfer?.files ?? [])
    .filter((file) => file.type.startsWith('image/') || file.type.startsWith('video/'));
  for (const file of files) await sendAttachment(file);
});

// Paste a screenshot straight into the thread.
input.addEventListener('paste', async (event) => {
  const files = Array.from(event.clipboardData?.files ?? [])
    .filter((file) => file.type.startsWith('image/'));
  if (!files.length) return;
  event.preventDefault();
  for (const file of files) await sendAttachment(file);
});

/**
 * Upload and send one photo or video.
 *
 * The optimistic bubble carries a local object URL so the image is on screen
 * before the upload starts; it is swapped for the public URL on confirm and
 * the object URL revoked, or removed entirely if the upload fails.
 */
async function sendAttachment(file) {
  if (!state.activeId) return;

  const isVideo = file.type.startsWith('video/');
  if (!isVideo && !file.type.startsWith('image/')) {
    toast('Only photos and videos can be sent from the web.');
    return;
  }

  const conversationId = state.activeId;
  const clientId = newClientId(isVideo ? 'video' : 'image');
  const tempId = newTempId(isVideo ? 'video' : 'image');
  const localUrl = URL.createObjectURL(file);

  store.injectMessage(conversationId, {
    id: tempId,
    clientId,
    conversationId,
    senderId: state.me.id,
    text: '',
    type: 'image',
    createdAt: new Date().toISOString(),
    metadata: {
      uploading: true,
      kind: isVideo ? 'video' : 'image',
      imageUrl: isVideo ? null : localUrl,
      posterUrl: isVideo ? null : undefined,
    },
  });
  scrollToBottom($('#thread'), true);

  try {
    if (isVideo) {
      const { url, posterUrl, width, height, durationMs } = await uploadVideo(file, state.me.id);
      await store.send(conversationId, url, {
        type: 'image',
        clientId,
        metadata: { kind: 'video', imageUrl: posterUrl, posterUrl, url, width, height, durationMs },
      });
    } else {
      const { url, width, height } = await uploadImage(file, state.me.id);
      await store.send(conversationId, url, {
        type: 'image',
        clientId,
        metadata: { imageUrl: url, width, height },
      });
    }
  } catch (err) {
    console.error('Attachment failed:', err);
    store.removeMessage(conversationId, tempId);
    toast(err?.message ?? 'Could not send that file.');
  } finally {
    URL.revokeObjectURL(localUrl);
  }
}

/* ── Voice notes ─────────────────────────────────────────────────────────── */

const recorder = new VoiceRecorder();
let recTimer = null;
let recStartedAt = 0;
let recLevels = [];

$('#btn-mic').addEventListener('click', startRecording);
$('#btn-rec-cancel').addEventListener('click', cancelRecording);
$('#btn-rec-send').addEventListener('click', finishRecording);

async function startRecording() {
  if (!state.activeId) return;

  try {
    recLevels = [];
    await recorder.start((level) => {
      recLevels.push(level);
      drawRecorderWave();
    });
  } catch (err) {
    console.error('Mic failed:', err);
    // NotAllowedError is a denied permission prompt, which needs different
    // advice from "no microphone attached".
    toast(err?.name === 'NotAllowedError'
      ? 'Microphone access was blocked. Allow it in your browser settings.'
      : 'Could not start recording.');
    return;
  }

  recStartedAt = Date.now();
  $('#composer-row').classList.add('is-hidden');
  $('#recorder').classList.remove('is-hidden');

  recTimer = setInterval(() => {
    $('#rec-time').textContent = formatDuration(Date.now() - recStartedAt);
  }, 200);
}

function stopRecorderUi() {
  clearInterval(recTimer);
  recTimer = null;
  $('#rec-time').textContent = '0:00';
  $('#recorder').classList.add('is-hidden');
  $('#composer-row').classList.remove('is-hidden');
  recLevels = [];
  drawRecorderWave();
}

function cancelRecording() {
  recorder.cancel();
  stopRecorderUi();
}

async function finishRecording() {
  let result;
  try {
    result = await recorder.stop();
  } catch (err) {
    console.error('Recorder stop failed:', err);
    stopRecorderUi();
    toast('Could not finish that recording.');
    return;
  }

  stopRecorderUi();
  if (!result) {
    toast('That recording was too short.');
    return;
  }

  const { blob, durationMs, waveform, mimeType } = result;
  const conversationId = state.activeId;
  if (!conversationId) return;

  const clientId = newClientId('voice');
  const tempId = newTempId('voice');

  store.injectMessage(conversationId, {
    id: tempId,
    clientId,
    conversationId,
    senderId: state.me.id,
    text: '',
    type: 'voice',
    createdAt: new Date().toISOString(),
    metadata: { uploading: true, durationMs, waveform },
  });
  scrollToBottom($('#thread'), true);

  try {
    const storagePath = await uploadVoiceNote(blob, state.me.id, mimeType);
    // The app stores the PATH as the message text as well as in metadata;
    // matching that keeps VoiceNoteBubble working on mobile.
    await store.send(conversationId, storagePath, {
      type: 'voice',
      clientId,
      metadata: { storagePath, durationMs, waveform },
    });
  } catch (err) {
    console.error('Voice note failed:', err);
    store.removeMessage(conversationId, tempId);
    toast('Could not send that voice note.');
  }
}

/** Live meter during recording — the tail of the samples, scrolling left. */
function drawRecorderWave() {
  const canvas = $('#rec-wave');
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;

  ctx.clearRect(0, 0, width, height);
  if (!recLevels.length) return;

  const barWidth = 3;
  const gap = 2;
  const visible = Math.floor(width / (barWidth + gap));
  const slice = recLevels.slice(-visible);

  ctx.fillStyle = '#0033ff';
  slice.forEach((level, i) => {
    const barHeight = Math.max(3, level * height);
    const x = i * (barWidth + gap);
    const y = (height - barHeight) / 2;
    ctx.beginPath();
    ctx.roundRect?.(x, y, barWidth, barHeight, 1.5);
    if (ctx.roundRect) ctx.fill();
    else ctx.fillRect(x, y, barWidth, barHeight);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Chrome wiring
   ═══════════════════════════════════════════════════════════════════════════ */

$('#search-input').addEventListener('input', (event) => {
  state.filter = event.target.value;
  renderConversations();
});

$('#btn-signout').addEventListener('click', () => {
  unsubscribeFromMessages();
  store.reset();
  signOut();
});

$('#btn-refresh').addEventListener('click', async () => {
  try {
    await store.loadConversations(state.me.id);
    toast('Up to date.');
  } catch {
    toast('Could not refresh right now.');
  }
});

onConnection((status) => {
  const dot = $('#conn-status');
  dot.dataset.state = status;
  dot.title = status === 'connected' ? 'Connected'
    : status === 'reconnecting' ? 'Reconnecting…' : 'Offline';
});

onIncoming((message, { isOwn, isActive }) => {
  if (!isActive) return;

  // Reading the thread the message landed in means it is already read.
  store.markRead(message.conversationId).catch(() => {});

  if (!isOwn) {
    // Their message clears the typing indicator that preceded it.
    state.partnerTyping = false;
    $('#chat-meta').textContent = '';
  }

  const thread = $('#thread');
  if (isOwn || isNearBottom(thread)) scrollToBottom(thread, true);
});

/* ═══════════════════════════════════════════════════════════════════════════
   Boot
   ═══════════════════════════════════════════════════════════════════════════ */

async function boot() {
  const userId = requireAuth();
  if (!userId) return;   // requireAuth() has already redirected

  // Paint identity from cache first so the rail is not blank while getMe()
  // round-trips.
  const cachedMe = getStoredUser();
  if (cachedMe) applyIdentity(cachedMe);

  const sessionOk = await ensureSession();
  if (!sessionOk) {
    // No session means every read below would fail RLS. Better to re-auth than
    // to show an empty inbox that looks like "you have no messages".
    location.replace(`/login/?next=${encodeURIComponent(location.pathname)}`);
    return;
  }

  const me = await getMe();
  if (!me) {
    location.replace('/login/');
    return;
  }

  state.me = me;
  store.userId = me.id;
  applyIdentity(me);

  $('#boot').hidden = true;
  $('#app').hidden = false;
  $('#app').dataset.view = 'list';

  store.onInbox((conversations) => {
    state.conversations = conversations;
    renderConversations();
  });

  try {
    const conversations = await store.loadConversations(me.id);
    state.conversations = conversations;
    renderConversations();

    // Warm the first few threads so the common case — clicking the top of the
    // list — opens with no spinner at all.
    conversations.slice(0, 8).forEach((convo, i) => {
      setTimeout(() => store.prefetch(convo.id), i * 90);
    });

    // Deep link: /messages/#<conversationId>
    const requested = location.hash.slice(1);
    const target = conversations.find((c) => c.id === requested);
    if (target) openConversation(target.id);
  } catch (err) {
    console.error('Failed to load conversations:', err);
    $('#conversation-list').replaceChildren();
    toast('Could not load your conversations.');
  }

  subscribeToMessages(me.id);
  watchConnectivity();
}

function applyIdentity(user) {
  $('#me-name').textContent = user.name || user.username || '';
  const avatar = $('#me-avatar');
  const url = user.dicebearAvatar || user.avatarUrl;
  if (url) {
    avatar.src = url;
    avatar.alt = '';
  }
}

// A signed-out tab left open should not keep polling a dead session.
window.addEventListener('beforeunload', () => unsubscribeFromMessages());

boot();
