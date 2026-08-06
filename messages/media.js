/**
 * Meetfleet — web messaging: media capture and upload.
 *
 * Ports the media paths of mobile/app/messages/[id].tsx and
 * mobile/services/voiceNotes.ts to browser APIs, writing to the same
 * `chat-media` bucket with the same key layout so a file uploaded from the web
 * is indistinguishable from one uploaded by the app:
 *
 *   images / video   `{senderId}/{ts}-{rand}.{ext}`   → public URL in metadata
 *   voice notes      `voice/{senderId}/{ts}-{rand}.{ext}` → storage PATH in metadata
 *
 * That asymmetry is inherited, not chosen: VoiceNoteBubble resolves its own
 * public URL from `metadata.storagePath`, while image bubbles read
 * `metadata.imageUrl` directly. Diverging here would break playback in the app.
 */

import { supabase } from './supabase.js';

const BUCKET = 'chat-media';

/** Matches IMG_MAX_PX / IMG_QUALITY in the app, so uploads stay comparable. */
const IMG_MAX_PX = 1200;
const IMG_QUALITY = 0.75;

/** Refuse oversized files before spending the user's bandwidth on them. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;   // 12 MB
export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;   // 64 MB

const rand = () => Math.random().toString(36).slice(2, 8);

/* ═══════════════════════════════════════════════════════════════════════════
   Images
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Downscale to IMG_MAX_PX on the long edge and re-encode as JPEG.
 *
 * Runs on a canvas, so it also strips EXIF — including GPS tags, which a photo
 * straight off a phone very often carries. Orientation is the one EXIF field
 * worth keeping, and `createImageBitmap` with `imageOrientation: 'from-image'`
 * bakes it into the pixels before the metadata is discarded.
 */
export async function compressImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });

  const scale = Math.min(1, IMG_MAX_PX / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', IMG_QUALITY));

  if (!blob) throw new Error('Could not process that image.');
  return { blob, width, height };
}

/** Upload a photo and return the public URL plus intrinsic dimensions. */
export async function uploadImage(file, senderId) {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('That image is too large. Please pick one under 12 MB.');
  }

  const { blob, width, height } = await compressImage(file);
  const path = `${senderId}/${Date.now()}-${rand()}.jpg`;

  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: 'image/jpeg',
    upsert: false,
    cacheControl: '31536000',
  });
  if (error) throw error;

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return { url: data.publicUrl, width, height };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Video

   Sent as type 'image' with `metadata.kind = 'video'`. The `messages.type`
   check constraint has no 'video' member, so a real video type would need a
   migration and a matching mobile release; until then this keeps web video
   working without stranding the message on older app builds, which render it
   through the image path.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Grab frame ~0 of a video file as a JPEG poster, so the bubble is not blank. */
async function extractPoster(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';

  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('Could not read that video.'));
      // A file the browser cannot decode would otherwise hang the send.
      setTimeout(() => reject(new Error('Video preview timed out.')), 8000);
    });

    // Seek slightly in: frame 0 of many recordings is a black or partial frame.
    await new Promise((resolve) => {
      video.onseeked = resolve;
      video.currentTime = Math.min(0.2, (video.duration || 1) / 10);
      setTimeout(resolve, 2000);
    });

    const scale = Math.min(1, IMG_MAX_PX / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', IMG_QUALITY));

    return {
      blob,
      width: video.videoWidth,
      height: video.videoHeight,
      durationMs: Math.round((video.duration || 0) * 1000),
    };
  } finally {
    URL.revokeObjectURL(url);
    video.src = '';
  }
}

/** Upload a video plus its poster frame. Returns both public URLs. */
export async function uploadVideo(file, senderId) {
  if (file.size > MAX_VIDEO_BYTES) {
    throw new Error('That video is too large. Please pick one under 64 MB.');
  }

  const poster = await extractPoster(file).catch(() => null);

  const ext = (file.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '');
  const stamp = `${Date.now()}-${rand()}`;
  const videoPath = `${senderId}/${stamp}.${ext || 'mp4'}`;

  const { error } = await supabase.storage.from(BUCKET).upload(videoPath, file, {
    contentType: file.type || 'video/mp4',
    upsert: false,
    cacheControl: '31536000',
  });
  if (error) throw error;

  const { data: videoData } = supabase.storage.from(BUCKET).getPublicUrl(videoPath);

  let posterUrl = null;
  if (poster?.blob) {
    const posterPath = `${senderId}/${stamp}-poster.jpg`;
    const { error: posterError } = await supabase.storage
      .from(BUCKET)
      .upload(posterPath, poster.blob, { contentType: 'image/jpeg', upsert: false });
    // A missing poster is cosmetic; the video itself already uploaded.
    if (!posterError) {
      posterUrl = supabase.storage.from(BUCKET).getPublicUrl(posterPath).data.publicUrl;
    }
  }

  return {
    url: videoData.publicUrl,
    posterUrl,
    width: poster?.width ?? null,
    height: poster?.height ?? null,
    durationMs: poster?.durationMs ?? null,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Voice notes
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Pick a container the browser can actually produce.
 *
 * Safari records audio/mp4 (AAC) and cannot produce WebM; Chrome and Firefox
 * do the reverse. Both are playable by the other, and by the app's expo-av
 * player, so recording in whatever is native is better than forcing one.
 */
function pickRecorderMime() {
  const candidates = [
    // AAC-in-MP4 must be requested BY CODEC, not as a bare 'audio/mp4'.
    // Chrome answers isTypeSupported('audio/mp4') with true and then records
    // `audio/mp4;codecs=opus` — Opus inside an MP4 container. That combination
    // is Chrome-only: Safari cannot decode it, and the app's expo-av player
    // expects AAC, so such a note uploads fine and then fails to play
    // everywhere except the browser that made it.
    'audio/mp4;codecs=mp4a.40.2',   // AAC-LC — the one both app and Safari read
    'audio/webm;codecs=opus',       // Chrome/Firefox native, playable in-app
    'audio/ogg;codecs=opus',
    'audio/webm',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) ?? '';
}

const EXT_BY_MIME = {
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
};

/**
 * Extension for whatever the recorder ACTUALLY produced.
 *
 * Always derive this from `recorder.mimeType` rather than the requested type:
 * a browser is free to hand back a different container than the one asked for,
 * and a `.m4a` name on a WebM payload misleads every downstream player.
 */
function extensionFor(mime) {
  const base = String(mime).split(';')[0].trim();
  return EXT_BY_MIME[base] ?? 'webm';
}

/** How many waveform bars a voice note carries. Matches the app's bubble. */
const WAVEFORM_BARS = 38;

/**
 * Records a voice note while sampling amplitude for the waveform.
 *
 * The waveform is captured live rather than decoded afterwards: decoding an
 * m4a/webm blob back to PCM costs a full extra decode of the recording, and
 * the live samples are what the user was watching anyway.
 */
export class VoiceRecorder {
  constructor() {
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.samples = [];
    this.startedAt = 0;
    this.audioContext = null;
    this.rafId = null;
    this.onLevel = null;
  }

  get isRecording() {
    return this.recorder?.state === 'recording';
  }

  /**
   * @param {(level: number) => void} onLevel  0..1 amplitude, for a live meter.
   */
  async start(onLevel) {
    this.onLevel = onLevel;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    const mimeType = pickRecorderMime();
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.samples = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };

    this.startedAt = Date.now();
    this.recorder.start(100);
    this.#startMeter();
  }

  #startMeter() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioCtx();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    const buffer = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      analyser.getByteTimeDomainData(buffer);

      // RMS around the 128 midpoint — a fair proxy for perceived loudness, and
      // steadier than peak amplitude on speech.
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) {
        const deviation = (buffer[i] - 128) / 128;
        sum += deviation * deviation;
      }
      const level = Math.min(1, Math.sqrt(sum / buffer.length) * 2.2);

      this.samples.push(level);
      this.onLevel?.(level);
      this.rafId = requestAnimationFrame(tick);
    };
    tick();
  }

  #stopMeter() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.audioContext?.close().catch(() => {});
    this.audioContext = null;
  }

  #releaseStream() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  /** Stop and return the recording, or null if it was too short to be real. */
  async stop() {
    if (!this.recorder) return null;

    const recorder = this.recorder;
    const durationMs = Date.now() - this.startedAt;

    const blob = await new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType }));
      recorder.stop();
    });

    this.#stopMeter();
    this.#releaseStream();
    this.recorder = null;

    // Under ~400ms is a mis-tap, not a message.
    if (durationMs < 400 || blob.size < 512) return null;

    return { blob, durationMs, waveform: this.#buildWaveform(), mimeType: recorder.mimeType };
  }

  /** Abandon the recording entirely — nothing is uploaded or returned. */
  cancel() {
    if (this.recorder?.state === 'recording') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.#stopMeter();
    this.#releaseStream();
    this.recorder = null;
    this.chunks = [];
    this.samples = [];
  }

  /**
   * Reduce the live samples to WAVEFORM_BARS buckets, normalised so the
   * loudest bar is full height — a quiet recording should still look like
   * speech rather than a flat line.
   */
  #buildWaveform() {
    if (!this.samples.length) return [];

    const bucketSize = this.samples.length / WAVEFORM_BARS;
    const bars = [];
    for (let i = 0; i < WAVEFORM_BARS; i++) {
      const slice = this.samples.slice(
        Math.floor(i * bucketSize),
        Math.max(Math.floor((i + 1) * bucketSize), Math.floor(i * bucketSize) + 1),
      );
      const peak = slice.length ? Math.max(...slice) : 0;
      bars.push(peak);
    }

    const loudest = Math.max(...bars, 0.0001);
    return bars.map((bar) => Math.round((bar / loudest) * 100) / 100);
  }
}

/**
 * Upload a voice note and return its storage PATH (not a URL).
 *
 * VoiceNoteBubble in the app resolves the public URL from this path itself, so
 * storing a URL here would break playback on mobile.
 * Mirrors uploadVoiceNote() in mobile/services/voiceNotes.ts.
 */
export async function uploadVoiceNote(blob, senderId, mimeType) {
  if (blob.size < 100) throw new Error('Voice note recording too small or empty');

  const ext = extensionFor(mimeType || blob.type);
  const path = `voice/${senderId}/${Date.now()}-${rand()}.${ext}`;

  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: mimeType || blob.type || 'audio/webm',
    upsert: false,
    cacheControl: '31536000',
  });
  if (error) throw error;

  return path;
}

/** Resolve a stored voice-note path to something an <audio> can play. */
export function publicUrlFor(path) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}
