/**
 * Meetfleet — web signup.
 *
 * A browser port of the mobile auth chain (mobile/app/(auth)/*). The step order,
 * the account-exists lookups, the OTP channels and the final `users` insert all
 * mirror the app so a person can start on one and finish on the other:
 *
 *   identifier ─┬─ phone     → OTP (WhatsApp)  ─┬─ [existing] → success
 *               │                               └─ [new]      → handle → …
 *               ├─ email     → OTP (WorkOS)    ─┬─ [existing] → success
 *               │                               └─ [new]      → handle → …
 *               └─ username  → password        ─┬─ [existing] → success
 *                                               └─ [new]      → avatar → …
 *
 *   … → avatar → identity → bio → CREATE ACCOUNT → success
 *
 * Apple resolves through Supabase OAuth and re-enters the chain at the handle
 * step when the account is new, as the app does. Google is intentionally NOT
 * offered on the web — it remains available in the mobile app, and the
 * `googleId` plumbing below stays so an account created there still signs in.
 *
 * Backend contract (all already live for the app — see SETUP.md):
 *   rpc  is_username_available / verify_user_password / set_user_password
 *   fn   workos-send-code / workos-verify-code   (email OTP)
 *   fn   wa-send-otp / wa-verify-otp             (phone OTP over WhatsApp)
 *   fn   get-auth-token                          (session mint)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {
  COUNTRIES,
  validatePhoneNumber,
  normalizeLocalDigits,
  getDefaultCountry,
} from './countries.js';

/* ═══════════════════════════════════════════════════════════════════════════
   Config
   ═══════════════════════════════════════════════════════════════════════════ */

// Same project + publishable key the app ships with. This key is designed to be
// public; every table it can reach is guarded by RLS.
const SUPABASE_URL = 'https://sbmeuhzmghaqkclaimid.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_0Gf3FQtxmbXg5w-lxAWqKQ__5fJa-dY';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const TOKEN_KEY = 'user_token';
const USER_KEY = 'current_user';

const DICEBEAR_STYLES = [
  { id: 'adventurer', label: 'Adventurer' },
  { id: 'lorelei', label: 'Lorelei' },
  { id: 'avataaars', label: 'Avataaars' },
  { id: 'big-ears', label: 'Big Ears' },
  { id: 'micah', label: 'Micah' },
  { id: 'pixel-art', label: 'Pixel Art' },
  { id: 'croodles', label: 'Croodles' },
  { id: 'thumbs', label: 'Thumbs' },
  { id: 'open-peeps', label: 'Open Peeps' },
];

const dicebearUrl = (style, seed, size = 200) =>
  `https://api.dicebear.com/9.x/${style}/png?seed=${encodeURIComponent(seed)}` +
  `&size=${size}&backgroundColor=b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf`;

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ═══════════════════════════════════════════════════════════════════════════
   Tiny DOM helpers
   ═══════════════════════════════════════════════════════════════════════════ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const show = (el) => el?.classList.remove('is-hidden');
const hide = (el) => el?.classList.add('is-hidden');
const setText = (sel, text) => { const el = $(sel); if (el) el.textContent = text ?? ''; };

/** Swap a button into/out of a loading state without losing its label. */
function setLoading(btn, loading, loadingLabel) {
  if (!btn) return;
  if (loading) {
    btn.dataset.label ??= btn.textContent.trim();
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${loadingLabel ?? btn.dataset.label}`;
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.label ?? btn.textContent;
  }
}

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  setText('#toast-text', message);
  el.classList.add('is-open');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-open'), 3800);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Navigation
   ═══════════════════════════════════════════════════════════════════════════ */

const history_ = [];

function goto(step, { push = true } = {}) {
  const current = $('.step.is-active');
  if (current) {
    if (push) history_.push(current.dataset.step);
    current.classList.remove('is-active');
  }
  const next = document.querySelector(`[data-step="${step}"]`);
  // Built on first arrival rather than at boot — see ensureAvatarBuilt().
  if (step === 'avatar') ensureAvatarBuilt();
  next?.classList.add('is-active');
  window.scrollTo({ top: 0, behavior: 'instant' });

  // Autofocus the step's first field, but never on touch — a forced keyboard
  // on mobile hides the content the user just navigated to.
  if (!matchMedia('(pointer: coarse)').matches) {
    setTimeout(() => next?.querySelector(
      'input:not([type=hidden]):not(.otp-hidden), textarea'
    )?.focus(), 60);
  }
}

function goBack() {
  const prev = history_.pop();
  if (prev) goto(prev, { push: false });
}

$$('[data-back]').forEach((btn) => btn.addEventListener('click', goBack));

/* ═══════════════════════════════════════════════════════════════════════════
   Signup state — accumulated across steps, spent by createAccount()
   ═══════════════════════════════════════════════════════════════════════════ */

const state = {
  method: 'username',      // 'phone' | 'username' | 'email'
  phone: null,             // verified E.164
  email: null,             // verified address
  username: null,
  password: null,
  appleId: null,
  googleId: null,
  name: null,
  gender: null,
  age: null,
  bio: null,
  avatarStyle: DICEBEAR_STYLES[0].id,
  avatarSeed: Math.random().toString(36).slice(2, 9),
  dicebearAvatar: null,
};

/* ═══════════════════════════════════════════════════════════════════════════
   Backend calls — same shapes as mobile/services/auth.ts
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Pull the real message out of a failed `functions.invoke`.
 *
 * On a non-2xx response supabase-js throws a FunctionsHttpError whose own
 * `.message` is just "Edge Function returned a non-2xx status code" — the
 * useful text ({ error: "..." }) is in the unread response body. Without this
 * every gateway problem reaches the user as the same opaque sentence.
 */
async function readFunctionError(error, fallback) {
  try {
    const body = await error?.context?.json?.();
    if (body?.error) return body.error;
  } catch { /* body already consumed or not JSON */ }

  const message = String(error?.message ?? '');
  if (message && !/non-2xx status code/i.test(message)) return message;
  return fallback;
}

/** PostgREST reports an undeployed function as PGRST202 / "does not exist". */
function isMissingFunction(error) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  return code === 'PGRST202' || code === '42883' || /could not find the function|does not exist/i.test(message);
}

/** Map create_web_account()'s RAISE codes onto sentences a person can act on. */
const DB_ERRORS = {
  username_taken: 'That username was just taken. Please pick another.',
  email_taken: 'An account already exists with that email address.',
  phone_taken: 'An account already exists with that phone number.',
  invalid_username: 'Usernames are 3–20 characters: letters, numbers and underscores.',
  invalid_email: 'That email address does not look right.',
  age_restricted: 'You must be 18 or older to join Meetfleet.',
  weak_password: 'Please use a password of at least 8 characters.',
  rate_limited: 'Too many signup attempts. Please try again a bit later.',
  no_login_method: 'We need an email, phone or password to secure your account.',
};

function friendlyDbError(error) {
  const raw = String(error?.message ?? '');
  for (const [code, message] of Object.entries(DB_ERRORS)) {
    if (raw.includes(code)) return message;
  }
  if (raw.includes('users_username_key') || error?.code === '23505') {
    return DB_ERRORS.username_taken;
  }
  return raw || 'Could not create your account. Please try again.';
}

const api = {
  async isUsernameAvailable(username) {
    const { data, error } = await supabase.rpc('is_username_available', { p_username: username });
    if (error) throw error;
    return data === true;
  },

  // Existence checks prefer the SECURITY DEFINER rpcs from signup/setup.sql,
  // which answer with a bare boolean and keep working after the `users` table
  // is locked down. They fall back to a direct select so this page runs against
  // a database where setup.sql has not been applied yet.
  async userExistsByEmail(email) {
    const { data, error } = await supabase.rpc('email_is_registered', { p_email: email });
    if (!error) return data === true;

    const { data: rows, error: selectError } = await supabase
      .from('users').select('id').eq('email', email).limit(1);
    if (selectError) throw selectError;
    return Array.isArray(rows) && rows.length > 0;
  },

  async userExistsByPhone(phone) {
    const { data, error } = await supabase.rpc('phone_is_registered', { p_phone: phone });
    if (!error) return data === true;

    const { data: rows, error: selectError } = await supabase
      .from('users').select('id').eq('phone', phone).limit(1);
    if (selectError) throw selectError;
    return Array.isArray(rows) && rows.length > 0;
  },

  async sendEmailOtp(email) {
    const { data, error } = await supabase.functions.invoke('workos-send-code', { body: { email } });
    if (error) throw new Error(await readFunctionError(error, 'Could not send the code. Please try again.'));
    if (data?.error) throw new Error(data.error);
  },

  async verifyEmailOtp(email, code) {
    const { data, error } = await supabase.functions.invoke('workos-verify-code', { body: { email, code } });
    if (error) throw new Error(await readFunctionError(error, 'That code is incorrect or expired.'));
    if (data?.error) throw new Error(data.error);
  },

  // `platform: 'web'` routes delivery through the WhatsApp session reserved for
  // the website (the `desktop` session) instead of the app's `meetfleet-otp`
  // one, so the two surfaces cannot take each other offline. There is no SMS
  // fallback on web — WhatsApp is the only phone channel here.
  async sendPhoneOtp(phone) {
    const { data, error } = await supabase.functions.invoke('wa-send-otp', {
      body: { phone, platform: 'web' },
    });
    if (error) throw new Error(await readFunctionError(error, 'Could not send the WhatsApp code.'));
    if (data?.error) throw new Error(data.error);
  },

  async verifyPhoneOtp(phone, code) {
    const { data, error } = await supabase.functions.invoke('wa-verify-otp', {
      body: { phone, code, platform: 'web' },
    });
    if (error) throw new Error(await readFunctionError(error, 'Could not verify that code.'));
    if (data?.error) throw new Error(data.error);
  },

  /** Username + password sign-in. Returns the user row, or null on bad credentials. */
  async login(username, password) {
    const { data: userId, error } = await supabase
      .rpc('verify_user_password', { p_username: username, p_password: password });
    if (error) throw error;
    if (!userId) return null;

    const { data: user, error: fetchError } = await supabase
      .from('users').select('*').eq('id', userId).single();
    if (fetchError) throw fetchError;
    return user;
  },

  async fetchUserBy(column, value) {
    const { data, error } = await supabase.from('users').select('*').eq(column, value).limit(1);
    if (error) throw error;
    return data?.[0] ?? null;
  },

  /** Resolve a federated identity, preferring the rpc that exposes no row. */
  async findByProvider(provider, providerId, column) {
    const { data: userId, error } = await supabase
      .rpc('find_user_by_provider', { p_provider: provider, p_provider_id: providerId });

    if (!error) {
      if (!userId) return null;
      const { data: summary } = await supabase.rpc('get_account_summary', { p_user_id: userId });
      return summary?.[0] ?? { id: userId };
    }
    if (!isMissingFunction(error)) throw error;
    return this.fetchUserBy(column, providerId);
  },

  /**
   * Create the account.
   *
   * Preferred path is create_web_account() from signup/setup.sql: it validates
   * the age gate and username rules server-side, enforces the column whitelist,
   * rate-limits, and bcrypts the password inside the same transaction as the
   * insert — so a rollback can never leave a half-made, passwordless row.
   *
   * If that function is not deployed yet, fall back to the app's own two-step
   * shape (insert, then set_user_password) so the page still works.
   */
  async register(payload) {
    const { data: userId, error } = await supabase.rpc('create_web_account', {
      p_username: payload.username,
      p_password: payload.password ?? null,
      p_email: payload.email ?? null,
      p_phone: payload.phone ?? null,
      p_name: payload.name ?? null,
      p_gender: payload.gender ?? null,
      p_age: payload.age ?? null,
      p_bio: payload.bio ?? null,
      p_avatar: payload.dicebearAvatar ?? null,
      p_google_id: payload.googleId ?? null,
      p_apple_id: payload.appleId ?? null,
    });

    if (!error) {
      const { data: summary } = await supabase.rpc('get_account_summary', { p_user_id: userId });
      return summary?.[0] ?? { id: userId, username: payload.username, dicebearAvatar: payload.dicebearAvatar };
    }

    // A genuine validation failure from the rpc must surface to the user; only
    // a missing function should fall through to the legacy path.
    if (!isMissingFunction(error)) throw new Error(friendlyDbError(error));

    const { password, ...row } = payload;
    const { data: user, error: insertError } = await supabase
      .from('users').insert([row]).select().single();
    if (insertError) throw new Error(friendlyDbError(insertError));

    if (password) {
      const { error: pwError } = await supabase
        .rpc('set_user_password', { p_user_id: user.id, p_password: password });
      // The account exists at this point. A failed hash means they cannot log in
      // with a password yet, which is recoverable via reset — do not tear down.
      if (pwError) console.error('set_user_password failed:', pwError);
    }
    return user;
  },

  /** Mint a Supabase session so the new account is signed in on this device. */
  async startSession(params) {
    try {
      const { data, error } = await supabase.functions.invoke('get-auth-token', { body: params });
      if (error || !data?.token) return;
      await supabase.auth.setSession({ access_token: data.token, refresh_token: '' });
    } catch (err) {
      console.warn('startSession failed (non-critical):', err);
    }
  },
};

function persistSession(user) {
  try {
    localStorage.setItem(TOKEN_KEY, user.id);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch { /* private mode / storage disabled — session is best-effort */ }
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 1 — Identifier
   ═══════════════════════════════════════════════════════════════════════════ */

let country = getDefaultCountry();

const els = {
  tabs: $$('.tab'),
  ctlPhone: $('#ctl-phone'),
  ctlUsername: $('#ctl-username'),
  ctlEmail: $('#ctl-email'),
  phoneInput: $('#phone-input'),
  usernameInput: $('#username-input'),
  emailInput: $('#email-input'),
  label: $('#identifier-label'),
  status: $('#identifier-status'),
  error: $('#identifier-error'),
  next: $('#btn-identifier-next'),
};

const LABELS = { phone: 'Phone number', username: 'Username', email: 'Email address' };

function renderCountry() {
  $('#country-flag').src = `https://flagcdn.com/w40/${country.code.toLowerCase()}.png`;
  $('#country-flag').alt = country.name;
  setText('#country-dial', country.dialCode);
}

function fullPhoneE164() {
  const digits = els.phoneInput.value.replace(/\D/g, '');
  return country.dialCode + normalizeLocalDigits(digits, country.dialCode);
}

function identifierIsValid() {
  if (state.method === 'phone') {
    const local = normalizeLocalDigits(els.phoneInput.value.replace(/\D/g, ''), country.dialCode);
    return local.length >= 6 && !validatePhoneNumber(country.dialCode, local);
  }
  if (state.method === 'email') return EMAIL_RE.test(els.emailInput.value.trim());
  return USERNAME_RE.test(els.usernameInput.value.trim());
}

function refreshIdentifier() {
  els.next.disabled = !identifierIsValid();
}

function switchTab(method) {
  if (method === state.method) return;
  state.method = method;
  els.tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === method)));
  els.label.textContent = LABELS[method];
  [els.ctlPhone, els.ctlUsername, els.ctlEmail].forEach(hide);
  show({ phone: els.ctlPhone, username: els.ctlUsername, email: els.ctlEmail }[method]);
  els.status.innerHTML = '';
  els.error.textContent = '';
  refreshIdentifier();
}

els.tabs.forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

/**
 * Tell the user up front whether this identifier signs in or registers.
 * Debounced, and results are keyed by the value that was looked up so a stale
 * response can never mislabel what the user is now typing.
 */
let statusToken = 0;
let statusTimer = null;

function scheduleStatusLookup() {
  clearTimeout(statusTimer);
  els.status.innerHTML = '';
  if (!identifierIsValid()) return;

  const token = ++statusToken;
  const method = state.method;
  const value = method === 'phone' ? fullPhoneE164()
    : method === 'email' ? els.emailInput.value.trim().toLowerCase()
      : els.usernameInput.value.trim().toLowerCase();

  statusTimer = setTimeout(async () => {
    try {
      const exists = method === 'phone' ? await api.userExistsByPhone(value)
        : method === 'email' ? await api.userExistsByEmail(value)
          : !(await api.isUsernameAvailable(value));
      if (token !== statusToken) return;   // user kept typing — discard
      renderStatusPill(exists);
    } catch { /* a failed hint is not worth surfacing; Next re-checks anyway */ }
  }, 400);
}

function renderStatusPill(exists) {
  els.status.innerHTML = `
    <div class="status-pill ${exists ? 'login' : 'signup'}">
      <span class="left">
        ${exists ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/></svg>` : ''}
        ${exists ? 'Existing account' : 'New here'}
      </span>
      <span class="action">${exists ? 'Logging in' : 'Creating account'}</span>
    </div>`;
}

[els.phoneInput, els.usernameInput, els.emailInput].forEach((input) => {
  input.addEventListener('input', () => {
    els.error.textContent = '';
    if (input === els.phoneInput) input.value = input.value.replace(/[^0-9]/g, '');
    if (input === els.usernameInput) input.value = input.value.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
    refreshIdentifier();
    scheduleStatusLookup();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !els.next.disabled) handleIdentifierNext();
  });
});

async function handleIdentifierNext() {
  if (!identifierIsValid()) return;
  els.error.textContent = '';
  setLoading(els.next, true, 'Checking…');

  try {
    if (state.method === 'phone') {
      const phone = fullPhoneE164();
      state.phone = phone;
      await api.sendPhoneOtp(phone);
      startOtpStep('phone', phone);
    } else if (state.method === 'email') {
      const email = els.emailInput.value.trim().toLowerCase();
      state.email = email;
      await api.sendEmailOtp(email);
      startOtpStep('email', email);
    } else {
      const username = els.usernameInput.value.trim().toLowerCase();
      state.username = username;
      const available = await api.isUsernameAvailable(username);
      startPasswordStep(available ? 'signup' : 'login');
    }
  } catch (err) {
    els.error.textContent = err?.message ?? 'Something went wrong. Please try again.';
  } finally {
    setLoading(els.next, false);
    refreshIdentifier();
  }
}

els.next.addEventListener('click', handleIdentifierNext);

/* ── Country picker ──────────────────────────────────────────────────────── */

const sheet = $('#country-sheet');
const backdrop = $('#sheet-backdrop');

function renderCountryList(query = '') {
  const q = query.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const matches = !q ? COUNTRIES : COUNTRIES.filter((c) =>
    c.name.toLowerCase().includes(q) ||
    (digits && c.dialCode.replace('+', '').startsWith(digits)));

  const list = $('#country-list');
  if (!matches.length) {
    list.innerHTML = '<p class="sheet-empty">No country matches that search.</p>';
    return;
  }
  list.innerHTML = matches.map((c) => `
    <button class="country-row ${c.code === country.code ? 'is-selected' : ''}" type="button" data-code="${c.code}">
      <img src="https://flagcdn.com/w40/${c.code.toLowerCase()}.png" alt="" width="24" height="17" loading="lazy">
      <span class="name">${c.name}</span>
      <span class="dial">${c.dialCode}</span>
    </button>`).join('');
}

function openSheet() {
  renderCountryList($('#country-search').value);
  backdrop.classList.add('is-open');
  sheet.classList.add('is-open');
}

function closeSheet() {
  backdrop.classList.remove('is-open');
  sheet.classList.remove('is-open');
  $('#country-search').value = '';
}

$('#country-btn').addEventListener('click', openSheet);
backdrop.addEventListener('click', closeSheet);
$('#country-search').addEventListener('input', (e) => renderCountryList(e.target.value));
$('#country-list').addEventListener('click', (e) => {
  const row = e.target.closest('[data-code]');
  if (!row) return;
  country = COUNTRIES.find((c) => c.code === row.dataset.code) ?? country;
  renderCountry();
  closeSheet();
  refreshIdentifier();
  scheduleStatusLookup();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheet.classList.contains('is-open')) closeSheet();
});

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 2 — OTP
   ═══════════════════════════════════════════════════════════════════════════ */

let otpChannel = 'email';

function startOtpStep(channel, target) {
  otpChannel = channel;
  setText('#otp-target', target);
  $('#step-otp').querySelector('.step-title').textContent =
    channel === 'phone' ? 'Check WhatsApp' : 'Check your inbox';
  $('#otp-sub').innerHTML = channel === 'phone'
    ? `We sent a 6-digit code over WhatsApp to <strong id="otp-target">${target}</strong>`
    : `We sent a 6-digit code to <strong id="otp-target">${target}</strong>`;
  $('#otp-hidden').value = '';
  renderOtp();
  $('#otp-error').textContent = '';
  goto('otp');
  setTimeout(() => $('#otp-hidden').focus(), 80);
}

function renderOtp() {
  const digits = $('#otp-hidden').value.replace(/\D/g, '').slice(0, 6);
  $$('#otp-row .otp-box').forEach((box, i) => {
    box.textContent = digits[i] ?? '';
    box.classList.toggle('is-filled', Boolean(digits[i]));
  });
  $('#btn-otp-verify').disabled = digits.length !== 6;
}

$('#otp-hidden').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  $('#otp-error').textContent = '';
  renderOtp();
  // Autosubmit on the sixth digit — matches the app, and is what an SMS
  // autofill should feel like.
  if (e.target.value.length === 6) handleOtpVerify();
});
$('#otp-proxy').addEventListener('click', () => $('#otp-hidden').focus());

async function handleOtpVerify() {
  const code = $('#otp-hidden').value;
  if (code.length !== 6) return;
  const btn = $('#btn-otp-verify');
  setLoading(btn, true, 'Verifying…');
  $('#otp-error').textContent = '';

  try {
    if (otpChannel === 'phone') {
      await api.verifyPhoneOtp(state.phone, code);
      const user = await api.fetchUserBy('phone', state.phone);
      if (user) return signInExisting(user);
    } else {
      await api.verifyEmailOtp(state.email, code);
      const user = await api.fetchUserBy('email', state.email);
      if (user) return signInExisting(user);
    }
    // New account: continue the chain at the handle step.
    goto('handle');
  } catch (err) {
    $('#otp-error').textContent = err?.message ?? 'That code is incorrect or expired.';
    $('#otp-hidden').value = '';
    renderOtp();
    $('#otp-hidden').focus();
  } finally {
    setLoading(btn, false);
    renderOtp();
  }
}

$('#btn-otp-verify').addEventListener('click', handleOtpVerify);

$('#btn-resend').addEventListener('click', async () => {
  try {
    if (otpChannel === 'phone') await api.sendPhoneOtp(state.phone);
    else await api.sendEmailOtp(state.email);
    toast('A new code is on its way.');
  } catch (err) {
    toast(err?.message ?? 'Could not resend the code.');
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 3 — Password
   ═══════════════════════════════════════════════════════════════════════════ */

let passwordMode = 'signup';

function startPasswordStep(mode) {
  passwordMode = mode;
  setText('#password-title', mode === 'login' ? 'Welcome back' : 'Create a password');
  setText('#password-sub', mode === 'login'
    ? `Enter the password for @${state.username}.`
    : "Pick something you'll remember, at least 8 characters.");
  $('#password-input').value = '';
  $('#password-input').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#password-error').textContent = '';
  $('#btn-password-next').disabled = true;
  setText('#btn-password-next', mode === 'login' ? 'Log in' : 'Continue');
  $('#btn-password-next').dataset.label = mode === 'login' ? 'Log in' : 'Continue';
  goto('password');
}

$('#password-input').addEventListener('input', (e) => {
  $('#password-error').textContent = '';
  $('#btn-password-next').disabled = e.target.value.length < 8;
});

$('#password-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('#btn-password-next').disabled) handlePasswordNext();
});

$('#btn-toggle-password').addEventListener('click', () => {
  const input = $('#password-input');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  $('#btn-toggle-password').setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  input.focus();
});

async function handlePasswordNext() {
  const password = $('#password-input').value;
  if (password.length < 8) return;
  const btn = $('#btn-password-next');
  setLoading(btn, true, passwordMode === 'login' ? 'Logging in…' : 'Checking…');
  $('#password-error').textContent = '';

  try {
    if (passwordMode === 'login') {
      const user = await api.login(state.username, password);
      if (!user) {
        $('#password-error').textContent = 'That password does not match this username.';
        return;
      }
      await api.startSession({ username: state.username, password });
      return signInExisting(user, { skipSession: true });
    }
    state.password = password;
    goto('avatar');
  } catch (err) {
    $('#password-error').textContent = err?.message ?? 'Something went wrong. Please try again.';
  } finally {
    setLoading(btn, false);
    $('#btn-password-next').disabled = $('#password-input').value.length < 8;
  }
}

$('#btn-password-next').addEventListener('click', handlePasswordNext);

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 4 — Handle (username for email/phone/social signups)
   ═══════════════════════════════════════════════════════════════════════════ */

$('#handle-input').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
  $('#handle-error').textContent = '';
  $('#btn-handle-next').disabled = !USERNAME_RE.test(e.target.value);
});

$('#handle-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('#btn-handle-next').disabled) handleHandleNext();
});

async function handleHandleNext() {
  const username = $('#handle-input').value.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) return;
  const btn = $('#btn-handle-next');
  setLoading(btn, true, 'Checking…');
  $('#handle-error').textContent = '';

  try {
    const available = await api.isUsernameAvailable(username);
    if (!available) {
      $('#handle-error').textContent = 'That username is taken. Try another.';
      return;
    }
    state.username = username;
    goto('avatar');
  } catch (err) {
    $('#handle-error').textContent = err?.message ?? 'Could not check that username.';
  } finally {
    setLoading(btn, false);
    $('#btn-handle-next').disabled = !USERNAME_RE.test($('#handle-input').value);
  }
}

$('#btn-handle-next').addEventListener('click', handleHandleNext);

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 5 — Avatar
   ═══════════════════════════════════════════════════════════════════════════ */

function renderAvatar({ bounce = false } = {}) {
  const hero = $('#avatar-hero-img');
  hero.src = dicebearUrl(state.avatarStyle, state.avatarSeed, 400);
  if (bounce) {
    hero.classList.remove('is-bouncing');
    void hero.offsetWidth;   // restart the animation
    hero.classList.add('is-bouncing');
  }
  $$('#style-scroller .style-thumb').forEach((thumb) => {
    thumb.setAttribute('aria-pressed', String(thumb.dataset.style === state.avatarStyle));
  });
}

function buildStyleScroller() {
  $('#style-scroller').innerHTML = DICEBEAR_STYLES.map((s) => `
    <button class="style-thumb" type="button" data-style="${s.id}" aria-pressed="false"
      title="${s.label}" aria-label="${s.label} style">
      <img src="${dicebearUrl(s.id, state.avatarSeed, 120)}" alt="" width="60" height="60" loading="lazy">
    </button>`).join('');
}

$('#style-scroller').addEventListener('click', (e) => {
  const thumb = e.target.closest('[data-style]');
  if (!thumb) return;
  state.avatarStyle = thumb.dataset.style;
  renderAvatar({ bounce: true });
});

$('#btn-dice').addEventListener('click', () => {
  state.avatarSeed = Math.random().toString(36).slice(2, 9);
  buildStyleScroller();
  renderAvatar({ bounce: true });
});

$('#btn-avatar-next').addEventListener('click', () => {
  state.dicebearAvatar = dicebearUrl(state.avatarStyle, state.avatarSeed);
  goto('identity');
});

/**
 * Build the avatar UI the first time that step is opened, not at boot.
 *
 * These are ~10 remote DiceBear images. Requesting them up front spends
 * bandwidth on a step many people have not reached yet, and an <img> carrying a
 * src inside a hidden step can be composited over the brand video by the
 * browser. Deferring solves both.
 */
let avatarReady = false;
function ensureAvatarBuilt() {
  if (avatarReady) return;
  avatarReady = true;
  buildStyleScroller();
  renderAvatar();
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 6 — Identity
   ═══════════════════════════════════════════════════════════════════════════ */

function calculateAge(birthDate) {
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) age -= 1;
  return age;
}

/* ── iOS-style date wheels ────────────────────────────────────────────────
   Three independent scroll-snap columns. Snapping is native (CSS
   scroll-snap-type), so this code only has to read the settled position and
   paint the selection — no per-frame scroll maths, and momentum feels right on
   both trackpad and touch.
   ──────────────────────────────────────────────────────────────────────────*/

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const ROW_HEIGHT = 40;               // must match .wheel-item height in CSS
const CURRENT_YEAR = new Date().getFullYear();
const MIN_YEAR = CURRENT_YEAR - 100;
const MAX_YEAR = CURRENT_YEAR - 18;  // the 18+ gate, enforced by the wheel itself

// What the wheels are currently showing. Committed to #dob-input on Done.
// Opening on mid-year rather than January 1 means every column starts with
// rows above and below it, so the drum reads as a wheel from the first frame.
const draft = { year: MAX_YEAR - 7, month: 5, day: 15 };

const wheels = {
  month: $('#wheel-month'),
  day: $('#wheel-day'),
  year: $('#wheel-year'),
};

const daysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();

function buildWheel(wheel, values, selectedIndex) {
  wheel.innerHTML = values.map((v, i) => `
    <div class="wheel-item" role="option" data-index="${i}"
      aria-selected="${i === selectedIndex}">${v.label}</div>`).join('');
}

/** Scroll a wheel so `index` sits in the centre band. */
function scrollWheelTo(wheel, index, smooth = false) {
  wheel.scrollTo({ top: index * ROW_HEIGHT, behavior: smooth ? 'smooth' : 'auto' });
}

/** Which row is currently under the centre band. */
const wheelIndex = (wheel) => Math.round(wheel.scrollTop / ROW_HEIGHT);

/** Paint selection + depth cues from the settled scroll position. */
function paintWheel(wheel) {
  const active = wheelIndex(wheel);
  wheel.querySelectorAll('.wheel-item').forEach((item, i) => {
    const distance = Math.abs(i - active);
    item.setAttribute('aria-selected', String(i === active));
    item.classList.toggle('is-near', distance === 1);
    item.classList.toggle('is-far', distance === 2);
    item.classList.toggle('is-farthest', distance >= 3);
  });
  return active;
}

function renderDayWheel({ preserve = true } = {}) {
  const max = daysInMonth(draft.year, draft.month);
  // Clamp before rebuilding: Jan 31 → Feb must land on 28/29, not vanish.
  if (draft.day > max) draft.day = max;
  const values = Array.from({ length: max }, (_, i) => ({ label: String(i + 1) }));
  buildWheel(wheels.day, values, draft.day - 1);
  if (preserve) scrollWheelTo(wheels.day, draft.day - 1);
  paintWheel(wheels.day);
}

function buildDateWheels() {
  buildWheel(wheels.month, MONTHS.map((m) => ({ label: m })), draft.month);

  const years = [];
  for (let y = MAX_YEAR; y >= MIN_YEAR; y--) years.push({ label: String(y) });
  buildWheel(wheels.year, years, MAX_YEAR - draft.year);

  renderDayWheel({ preserve: false });

  scrollWheelTo(wheels.month, draft.month);
  scrollWheelTo(wheels.year, MAX_YEAR - draft.year);
  scrollWheelTo(wheels.day, draft.day - 1);
  Object.values(wheels).forEach(paintWheel);
}

// Read each wheel once its scroll settles. `scrollend` is the precise signal;
// the timeout is the fallback for browsers that do not fire it yet.
function onWheelSettled(wheel, handler) {
  let timer = null;
  const settle = () => { clearTimeout(timer); timer = setTimeout(handler, 90); };
  wheel.addEventListener('scroll', () => { paintWheel(wheel); settle(); }, { passive: true });
  wheel.addEventListener('scrollend', handler);
}

onWheelSettled(wheels.month, () => {
  draft.month = Math.min(paintWheel(wheels.month), 11);
  renderDayWheel();
});

onWheelSettled(wheels.year, () => {
  draft.year = MAX_YEAR - paintWheel(wheels.year);
  renderDayWheel();
});

onWheelSettled(wheels.day, () => {
  draft.day = paintWheel(wheels.day) + 1;
});

// Tapping a row is faster than scrolling to it.
Object.values(wheels).forEach((wheel) => {
  wheel.addEventListener('click', (e) => {
    const item = e.target.closest('.wheel-item');
    if (item) scrollWheelTo(wheel, Number(item.dataset.index), true);
  });
  // Arrow keys move one row at a time.
  wheel.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const next = wheelIndex(wheel) + (e.key === 'ArrowDown' ? 1 : -1);
    const max = wheel.querySelectorAll('.wheel-item').length - 1;
    scrollWheelTo(wheel, Math.max(0, Math.min(max, next)), true);
  });
});

const formatDob = (y, m, d) =>
  `${MONTHS[m]} ${d}, ${y}`;

const isoDob = (y, m, d) =>
  `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function openDatePicker() {
  // Re-seed from the committed value so reopening resumes where it left off.
  const existing = $('#dob-input').value;
  if (existing) {
    const [y, m, d] = existing.split('-').map(Number);
    draft.year = y; draft.month = m - 1; draft.day = d;
  }
  buildDateWheels();
  $('#date-backdrop').classList.add('is-open');
  $('#date-sheet').classList.add('is-open');
  $('#dob-trigger').setAttribute('aria-expanded', 'true');
}

function closeDatePicker() {
  $('#date-backdrop').classList.remove('is-open');
  $('#date-sheet').classList.remove('is-open');
  $('#dob-trigger').setAttribute('aria-expanded', 'false');
  $('#dob-trigger').focus();
}

function commitDate() {
  const { year, month, day } = draft;
  $('#dob-input').value = isoDob(year, month, day);
  const display = $('#dob-display');
  display.textContent = formatDob(year, month, day);
  display.classList.remove('is-placeholder');
  closeDatePicker();
  refreshIdentity();
}

$('#dob-trigger').addEventListener('click', openDatePicker);
$('#date-cancel').addEventListener('click', closeDatePicker);
$('#date-done').addEventListener('click', commitDate);
$('#date-backdrop').addEventListener('click', closeDatePicker);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#date-sheet').classList.contains('is-open')) closeDatePicker();
});

function refreshIdentity() {
  const name = $('#name-input').value.trim();
  const dobValue = $('#dob-input').value;
  let ok = Boolean(name) && Boolean(state.gender) && Boolean(dobValue);

  if (dobValue) {
    // The year wheel already stops at MAX_YEAR, so this is a belt-and-braces
    // check that also covers a value restored from a previous session.
    const age = calculateAge(new Date(dobValue));
    if (age < 18) {
      $('#dob-error').textContent = 'You must be at least 18 years old to join.';
      $('#dob-trigger').classList.add('is-invalid');
      ok = false;
    } else {
      $('#dob-error').textContent = '';
      $('#dob-trigger').classList.remove('is-invalid');
    }
  }
  $('#btn-identity-next').disabled = !ok;
}

$('#name-input').addEventListener('input', refreshIdentity);

$('#gender-row').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-gender]');
  if (!chip) return;
  state.gender = chip.dataset.gender;
  $$('#gender-row .chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
  refreshIdentity();
});

$('#btn-identity-next').addEventListener('click', () => {
  state.name = $('#name-input').value.trim().replace(/\s+/g, ' ');
  state.age = calculateAge(new Date($('#dob-input').value));
  goto('bio');
});

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 7 — Bio → create account
   ═══════════════════════════════════════════════════════════════════════════ */

$('#bio-input').addEventListener('input', (e) => {
  setText('#bio-count', String(e.target.value.length));
});

$('#btn-create').addEventListener('click', async () => {
  const btn = $('#btn-create');
  setLoading(btn, true, 'Creating…');
  $('#bio-error').textContent = '';

  try {
    // Explicit whitelist, same as the app's register payload: anything not
    // named here is deliberately not persisted.
    const payload = {
      username: state.username,
      name: state.name || undefined,
      email: state.email || undefined,
      phone: state.phone || undefined,
      password: state.password || undefined,
      dicebearAvatar: state.dicebearAvatar,
      gender: state.gender || undefined,
      age: state.age ?? undefined,
      bio: $('#bio-input').value.trim() || undefined,
      appleId: state.appleId || undefined,
      googleId: state.googleId || undefined,
      interests: [],
      music: [],
    };
    Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

    const user = await api.register(payload);
    persistSession(user);
    await api.startSession({ userId: user.id });
    showSuccess('signup', user);
  } catch (err) {
    const message = friendlyDbError(err);
    // A duplicate here means someone claimed the handle between our check and
    // this insert. Send them back to fix it rather than failing opaquely.
    if (message === DB_ERRORS.username_taken) {
      $('#handle-error').textContent = message;
      // A username-path signup has no handle step in its history; send those
      // users back to the identifier so they are never stranded.
      goto(state.method === 'username' ? 'identifier' : 'handle');
      return;
    }
    $('#bio-error').textContent = message;
  } finally {
    setLoading(btn, false);
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 8 — Success
   ═══════════════════════════════════════════════════════════════════════════ */

function showSuccess(mode, user) {
  const avatar = user?.dicebearAvatar || user?.avatarUrl;
  if (avatar) {
    $('#success-avatar').src = avatar;
    show($('#success-avatar'));
    hide($('#success-mark'));
  }
  // Signing up on the web is only ever step one — everything Meetfleet does
  // happens in the app, so the success screen's whole job is to hand the user
  // over to mobile with the identity they just created.
  const handle = user?.username ? `@${user.username}` : (state.username ? `@${state.username}` : null);
  if (handle) {
    setText('#handoff-handle', handle);
  } else {
    hide($('#handoff'));
  }

  setText('#success-title', mode === 'signin' ? 'Welcome back' : 'Your account is ready');
  setText('#success-sub', mode === 'signin'
    ? `Good to see you again${user?.name ? `, ${user.name.split(' ')[0]}` : ''}. Meetfleet lives on your phone. Open the app and sign in to pick up where you left off.`
    : 'Meetfleet lives on your phone. Download the app and sign in with the details you just created to start joining plans near you.');
  goto('success');
}

async function signInExisting(user, { skipSession = false } = {}) {
  persistSession(user);
  if (!skipSession) await api.startSession({ userId: user.id });
  showSuccess('signin', user);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Social — Apple via Supabase OAuth
   Apple is the only social provider offered on the web. Google is deliberately
   absent here; it remains available in the mobile app.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Put the social button back to rest — used on every OAuth failure path. */
function resetSocialButtons() {
  setLoading($('#btn-apple'), false);
}

const PROVIDER_LABEL = { apple: 'Apple' };

async function startOAuth(provider) {
  const btn = $('#btn-apple');
  setLoading(btn, true, 'Redirecting…');

  // If the redirect has not happened in a few seconds, something upstream is
  // wrong (provider disabled in Supabase, redirect URL not allow-listed). Give
  // the button back rather than leaving it spinning forever.
  const stuck = setTimeout(() => {
    setLoading(btn, false);
    toast(`${PROVIDER_LABEL[provider]} sign-in did not start. Please try again.`);
  }, 6000);

  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${location.origin}/signup/?oauth=${provider}`,
        // Apple hands back the email/name only when they are requested, and
        // only on the very first authorization.
        ...(provider === 'apple' ? { scopes: 'name email' } : {}),
      },
    });
    if (error) throw error;

    // signInWithOAuth normally navigates the page itself. If it returned a URL
    // without navigating, follow it explicitly.
    if (data?.url && location.href.indexOf(data.url) !== 0) {
      window.location.assign(data.url);
    }
  } catch (err) {
    clearTimeout(stuck);
    setLoading(btn, false);
    const message = String(err?.message ?? '');
    // The most common real-world cause, phrased so it is actionable.
    if (/provider is not enabled|unsupported provider/i.test(message)) {
      toast(`${PROVIDER_LABEL[provider]} sign-in is not enabled for this project yet.`);
    } else {
      toast(message || `Could not sign in with ${PROVIDER_LABEL[provider]}.`);
    }
  }
}

/**
 * Apple's authorize endpoint answers "Invalid client id or web redirect url"
 * whenever the configured client_id is an iOS bundle id rather than a Services
 * ID — Sign in with Apple on the WEB needs its own Services ID. Apple posts
 * that failure back to our redirect, so catch it here and say something the
 * user can act on instead of dropping them on a blank step.
 */
function appleConfigErrorMessage(raw) {
  if (/invalid_client|invalid client id|invalid_request/i.test(String(raw ?? ''))) {
    return 'Apple sign-in is not available on the web yet. Please use email or phone instead.';
  }
  return null;
}

$('#btn-apple').addEventListener('click', () => startOAuth('apple'));

/**
 * Return leg of the OAuth redirect.
 *
 * Known provider id → sign straight in. Unknown → enter the signup chain at the
 * handle step, seeded with the email/name Apple returned. Same two-branch
 * routing as handleAppleLogin in the app.
 */
async function resumeFromOAuth() {
  const params = new URLSearchParams(location.search);
  const provider = params.get('oauth');
  // Apple is the only provider the web offers; ignore a callback for anything
  // else rather than driving a flow this page cannot complete.
  if (provider !== 'apple') return false;

  // The Supabase JS client defaults to the PKCE flow, so a successful callback
  // arrives as `?code=` in the QUERY STRING and must be EXCHANGED for a session
  // — getSession() alone returns null here, which is what left the button
  // spinning forever. Implicit-flow callbacks (`#access_token=`) are accepted
  // too, so this keeps working whichever flowType the client is on.
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const hashParams = new URLSearchParams(location.hash.slice(1));
  const accessToken = hashParams.get('access_token');
  const refreshToken = hashParams.get('refresh_token');
  const oauthError = url.searchParams.get('error_description')
    ?? url.searchParams.get('error')
    ?? hashParams.get('error_description');

  let identity = null;
  try {
    if (code) {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      if (error || !data?.user) throw new Error(error?.message ?? 'Could not verify that account.');
      identity = data.user;
    } else if (accessToken && refreshToken) {
      const { data, error } = await supabase.auth.setSession({
        access_token: accessToken, refresh_token: refreshToken,
      });
      if (error || !data?.user) throw new Error(error?.message ?? 'Could not verify that account.');
      identity = data.user;
    } else {
      // A cancelled or failed authorization lands here. Surface the provider's
      // own reason rather than silently doing nothing.
      const { data } = await supabase.auth.getSession();
      identity = data?.session?.user ?? null;
      if (!identity) throw new Error(oauthError ?? 'Sign-in was not completed.');
    }
  } catch (err) {
    history.replaceState(null, '', location.pathname);
    resetSocialButtons();
    const raw = err?.message ?? oauthError ?? '';
    const configHint = provider === 'apple' ? appleConfigErrorMessage(raw) : null;
    toast(configHint ?? raw ?? 'Sign-in was not completed.');
    return false;
  }

  // Scrub the address bar so the code/tokens are not left in history.
  history.replaceState(null, '', location.pathname);

  // Identity MUST be the immutable provider subject id, never the email: an
  // email can be renamed or re-assigned, which would silently orphan the
  // account. Prefer the provider's `sub`, then Supabase's stable user id.
  const providerId = identity.user_metadata?.sub
    ?? identity.user_metadata?.provider_id
    ?? identity.id;
  const email = identity.email ?? null;
  const name = identity.user_metadata?.full_name ?? identity.user_metadata?.name ?? null;
  const column = 'appleId';

  try {
    let user = await api.findByProvider('apple', providerId, column);
    if (!user && email) user = await api.fetchUserBy('email', email);

    // Done with the provider session — everything past this point is our own
    // auth, and leaving it live would let a stale OAuth session shadow it.
    await supabase.auth.signOut().catch(() => {});

    if (user) {
      // Link the provider to an account that was created another way, so the
      // next sign-in resolves by id instead of falling back to email.
      if (!user[column]) {
        await supabase.from('users').update({ [column]: providerId }).eq('id', user.id).select();
      }
      await signInExisting(user);
      return true;
    }

    state.method = 'apple';
    state.email = email;
    state.name = name;
    state.appleId = providerId;

    if (name) $('#name-input').value = name;
    // Apple returns an email ONLY on the first authorization, and nothing at
    // all if the user previously authorized then revoked.
    if (!email) toast('Your provider did not share an email, so you can add one later in the app.');

    // Seed the handle field from the email's local part; it is almost always
    // what the user would have typed anyway.
    if (email) {
      const suggestion = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').toLowerCase().slice(0, 20);
      if (USERNAME_RE.test(suggestion)) {
        const input = $('#handle-input');
        input.value = suggestion;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    goto('handle');
    return true;
  } catch (err) {
    resetSocialButtons();
    toast(err?.message ?? 'Could not complete that sign-in.');
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Boot
   ═══════════════════════════════════════════════════════════════════════════ */

// Keep the copyright year current without anyone having to remember to edit it.
setText('#brand-year', String(new Date().getFullYear()));

/* ═══════════════════════════════════════════════════════════════════════════
   Ambient brand video

   Decorative, so it must never cost the user anything they did not ask for.
   The <video> ships with preload="none" and NO sources; they are attached only
   once we have decided this visitor should get it:

     • the brand panel is display:none below 960px, so phones never fetch it
     • prefers-reduced-motion and Save-Data opt out entirely
     • a decode/network failure just leaves the flat blue, which is a complete
       design on its own
     • playback pauses when the tab is hidden, so a backgrounded signup page
       does not keep a decoder alive
   ═══════════════════════════════════════════════════════════════════════════ */

function initBrandVideo() {
  const video = $('#brand-video');
  if (!video) return;

  const DESKTOP = '(min-width: 960px)';
  const wantsLessMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const savingData = navigator.connection?.saveData === true;
  // 2g/3g: the poster alone is the better experience.
  const slowLink = /(^|[^4])g$/.test(navigator.connection?.effectiveType ?? '');

  if (wantsLessMotion || savingData || slowLink) return;

  let attached = false;

  const attach = () => {
    if (attached) return;
    attached = true;

    // WebM first: ~2.3x smaller than the mp4 at the same quality. Safari skips
    // it and takes the H.264, which is why both exist.
    if (video.children.length === 0) {
      for (const [src, type] of [
        ['../assets/video/signup.webm', 'video/webm'],
        ['../assets/video/signup.mp4', 'video/mp4'],
      ]) {
        const source = document.createElement('source');
        source.src = src;
        source.type = type;
        video.appendChild(source);
      }
    }

    video.preload = 'auto';
    video.load();

    // Only reveal once frames are actually running, so the poster never
    // cross-fades into a stalled first frame.
    video.addEventListener('playing', () => video.classList.add('is-playing'), { once: true });

    // Autoplay can still be refused (battery saver, per-site settings). That is
    // not an error worth surfacing — the poster and flat blue carry the panel.
    video.play?.().catch(() => {});
  };

  const desktop = matchMedia(DESKTOP);
  if (desktop.matches) attach();
  // Someone who widens the window (or rotates a tablet) into the desktop layout
  // should get the video too — but we still never fetch it while narrow.
  desktop.addEventListener('change', (e) => { if (e.matches) attach(); });

  document.addEventListener('visibilitychange', () => {
    if (!attached) return;
    if (document.hidden) video.pause();
    else video.play?.().catch(() => {});
  });
}

initBrandVideo();

renderCountry();
switchTab('username');
els.label.textContent = LABELS.username;

resumeFromOAuth().catch(() => {});
