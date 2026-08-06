/**
 * Meetfleet — web login.
 *
 * The sign-in half of /signup, extracted into its own page. Same three methods,
 * same backend contract, same visual chain — but every branch that would have
 * created an account instead tells the user there is nothing to sign in to and
 * points them at /signup:
 *
 *   identifier ─┬─ phone     → OTP (WhatsApp)  ─┬─ [known]   → session → /messages
 *               │                               └─ [unknown] → "no account" → /signup
 *               ├─ email     → OTP (WorkOS)    ─┬─ [known]   → session → /messages
 *               │                               └─ [unknown] → "no account" → /signup
 *               └─ username  → password        ─┬─ [known]   → session → /messages
 *                                               └─ [unknown] → "no account" → /signup
 *
 * Apple resolves through Supabase OAuth; an unrecognised Apple identity is sent
 * to /signup rather than half-creating a row here.
 *
 * On success the page writes the same two localStorage keys the app writes to
 * its own storage (`user_token` = user id, `current_user` = the row) and mints
 * a Supabase session via get-auth-token, so /messages can read `messages` under
 * RLS exactly as the mobile client does.
 *
 * Backend contract (all already live — see signup/SETUP.md):
 *   rpc  verify_user_password / is_username_available
 *   rpc  email_is_registered / phone_is_registered / find_user_by_provider
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
} from '../signup/countries.js';

/* ═══════════════════════════════════════════════════════════════════════════
   Config
   ═══════════════════════════════════════════════════════════════════════════ */

// Same project + publishable key the app and /signup ship with. This key is
// designed to be public; every table it can reach is guarded by RLS.
const SUPABASE_URL = 'https://sbmeuhzmghaqkclaimid.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_0Gf3FQtxmbXg5w-lxAWqKQ__5fJa-dY';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const TOKEN_KEY = 'user_token';
const USER_KEY = 'current_user';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Where to land once signed in. ?next= lets /messages bounce here and back. */
const NEXT_URL = (() => {
  const raw = new URLSearchParams(location.search).get('next');
  // Same-origin paths only — an open redirect here would be a phishing vector.
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/messages/';
})();

/* ═══════════════════════════════════════════════════════════════════════════
   Tiny DOM helpers — same shapes as signup.js
   ═══════════════════════════════════════════════════════════════════════════ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const show = (el) => el?.classList.remove('is-hidden');
const hide = (el) => el?.classList.add('is-hidden');
const setText = (sel, text) => { const el = $(sel); if (el) el.textContent = text ?? ''; };

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
  $(`[data-step="${step}"]`)?.classList.add('is-active');
  window.scrollTo({ top: 0, behavior: 'instant' });

  if (!matchMedia('(pointer: coarse)').matches) {
    setTimeout(() => $(`[data-step="${step}"]`)?.querySelector(
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
   Login state
   ═══════════════════════════════════════════════════════════════════════════ */

const state = {
  method: 'username',   // 'phone' | 'username' | 'email' | 'apple'
  phone: null,
  email: null,
  username: null,
};

/* ═══════════════════════════════════════════════════════════════════════════
   Backend calls — same shapes as signup.js / mobile services/auth.ts
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Pull the real message out of a failed `functions.invoke`. supabase-js reports
 * every non-2xx as "Edge Function returned a non-2xx status code"; the useful
 * text is in the unread response body.
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

const api = {
  async isUsernameAvailable(username) {
    const { data, error } = await supabase.rpc('is_username_available', { p_username: username });
    if (error) throw error;
    return data === true;
  },

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
  // the website (the `desktop` session), so web and app cannot take each other
  // offline. There is no SMS fallback on web.
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

  /** Mint a Supabase session so RLS-guarded reads work on /messages. */
  async startSession(params) {
    try {
      const { data, error } = await supabase.functions.invoke('get-auth-token', { body: params });
      if (error || !data?.token) return false;
      await supabase.auth.setSession({ access_token: data.token, refresh_token: '' });
      return true;
    } catch (err) {
      console.warn('startSession failed (non-critical):', err);
      return false;
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
 * Tell the user up front whether this identifier has an account, so an unknown
 * one is caught before we spend an OTP on it. Debounced, and keyed by the value
 * looked up so a stale response can never mislabel what is now typed.
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
        ${exists ? 'Account found' : 'No account yet'}
      </span>
      <span class="action">${exists ? 'Logging in' : 'Sign up instead'}</span>
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

/**
 * Send an unknown identifier to /signup carrying what they already typed, so
 * they do not have to enter it a second time.
 */
function bounceToSignup(message) {
  els.error.innerHTML =
    `${message} <a href="/signup/">Create an account</a> instead.`;
}

async function handleIdentifierNext() {
  if (!identifierIsValid()) return;
  els.error.textContent = '';
  setLoading(els.next, true, 'Checking…');

  try {
    if (state.method === 'phone') {
      const phone = fullPhoneE164();
      // Check before spending an OTP — an unknown number has nothing to sign in to.
      if (!(await api.userExistsByPhone(phone))) {
        bounceToSignup('No Meetfleet account uses that number.');
        return;
      }
      state.phone = phone;
      await api.sendPhoneOtp(phone);
      startOtpStep('phone', phone);
    } else if (state.method === 'email') {
      const email = els.emailInput.value.trim().toLowerCase();
      if (!(await api.userExistsByEmail(email))) {
        bounceToSignup('No Meetfleet account uses that email.');
        return;
      }
      state.email = email;
      await api.sendEmailOtp(email);
      startOtpStep('email', email);
    } else {
      const username = els.usernameInput.value.trim().toLowerCase();
      if (await api.isUsernameAvailable(username)) {
        bounceToSignup(`Nobody is using @${username}.`);
        return;
      }
      state.username = username;
      startPasswordStep();
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
  setText('#otp-title', channel === 'phone' ? 'Check WhatsApp' : 'Check your inbox');
  $('#otp-sub').innerHTML = channel === 'phone'
    ? `We sent a 6-digit code over WhatsApp to <strong>${target}</strong>`
    : `We sent a 6-digit code to <strong>${target}</strong>`;
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
    const [column, value] = otpChannel === 'phone'
      ? ['phone', state.phone]
      : ['email', state.email];

    if (otpChannel === 'phone') await api.verifyPhoneOtp(value, code);
    else await api.verifyEmailOtp(value, code);

    const user = await api.fetchUserBy(column, value);
    if (!user) {
      // The pre-check said this identifier existed, so getting here means the
      // row is unreadable rather than absent — say so instead of offering signup.
      $('#otp-error').textContent = 'Verified, but we could not load that account. Please try again.';
      return;
    }
    await signInExisting(user);
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

function startPasswordStep() {
  $('#password-input').value = '';
  $('#password-sub').innerHTML = `Welcome back, <strong>@${state.username}</strong>.`;
  $('#password-error').textContent = '';
  $('#btn-password-next').disabled = true;
  goto('password');
}

$('#password-input').addEventListener('input', (e) => {
  $('#password-error').textContent = '';
  // Sign-in must accept whatever the account was created with, including
  // passwords shorter than today's minimum — only gate on non-empty.
  $('#btn-password-next').disabled = e.target.value.length === 0;
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
  if (!password) return;
  const btn = $('#btn-password-next');
  setLoading(btn, true, 'Logging in…');
  $('#password-error').textContent = '';

  try {
    const user = await api.login(state.username, password);
    if (!user) {
      $('#password-error').textContent = 'That password does not match this username.';
      return;
    }
    // Prefer the username+password mint: it is the one path where the edge
    // function can verify the credential itself.
    await api.startSession({ username: state.username, password });
    await signInExisting(user, { skipSession: true });
  } catch (err) {
    $('#password-error').textContent = err?.message ?? 'Something went wrong. Please try again.';
  } finally {
    setLoading(btn, false);
    $('#btn-password-next').disabled = $('#password-input').value.length === 0;
  }
}

$('#btn-password-next').addEventListener('click', handlePasswordNext);

/* ═══════════════════════════════════════════════════════════════════════════
   Success → /messages
   ═══════════════════════════════════════════════════════════════════════════ */

function showSuccess(user) {
  const avatar = user?.dicebearAvatar || user?.avatarUrl;
  if (avatar) {
    $('#success-avatar').src = avatar;
    show($('#success-avatar'));
    hide($('#success-mark'));
  }

  const handle = user?.username ? `@${user.username}` : null;
  if (handle) setText('#handoff-handle', handle);
  else hide($('#handoff'));

  setText('#success-title', `Welcome back${user?.name ? `, ${String(user.name).split(' ')[0]}` : ''}.`);
  setText('#success-sub', 'Taking you to your messages…');
  $('#btn-go-messages').href = NEXT_URL;
  goto('success');

  // Brief pause so the confirmation is readable rather than a flash.
  setTimeout(() => { location.assign(NEXT_URL); }, 900);
}

async function signInExisting(user, { skipSession = false } = {}) {
  persistSession(user);
  if (!skipSession) await api.startSession({ userId: user.id });
  showSuccess(user);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Social — Apple via Supabase OAuth
   ═══════════════════════════════════════════════════════════════════════════ */

function resetSocialButtons() {
  setLoading($('#btn-apple'), false);
}

const PROVIDER_LABEL = { apple: 'Apple' };

async function startOAuth(provider) {
  const btn = $('#btn-apple');
  setLoading(btn, true, 'Redirecting…');

  // If the redirect has not happened in a few seconds, something upstream is
  // wrong (provider disabled, redirect URL not allow-listed). Give the button
  // back rather than leaving it spinning forever.
  const stuck = setTimeout(() => {
    setLoading(btn, false);
    toast(`${PROVIDER_LABEL[provider]} sign-in did not start. Please try again.`);
  }, 6000);

  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${location.origin}/login/?oauth=${provider}`,
        ...(provider === 'apple' ? { scopes: 'name email' } : {}),
      },
    });
    if (error) throw error;

    if (data?.url && location.href.indexOf(data.url) !== 0) {
      window.location.assign(data.url);
    }
  } catch (err) {
    clearTimeout(stuck);
    setLoading(btn, false);
    const message = String(err?.message ?? '');
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
 * ID — Sign in with Apple on the WEB needs its own Services ID.
 */
function appleConfigErrorMessage(raw) {
  if (/invalid_client|invalid client id|invalid_request/i.test(String(raw ?? ''))) {
    return 'Apple sign-in is not available on the web yet. Please use email or phone instead.';
  }
  return null;
}

$('#btn-apple').addEventListener('click', () => startOAuth('apple'));

/**
 * Return leg of the OAuth redirect. A known provider id signs straight in; an
 * unknown one is handed to /signup, since this page never creates accounts.
 */
async function resumeFromOAuth() {
  const params = new URLSearchParams(location.search);
  const provider = params.get('oauth');
  if (provider !== 'apple') return false;

  // The client defaults to PKCE, so a successful callback arrives as `?code=`
  // and must be EXCHANGED for a session — getSession() alone returns null.
  // Implicit-flow callbacks (`#access_token=`) are accepted too.
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
      const { data } = await supabase.auth.getSession();
      identity = data?.session?.user ?? null;
      if (!identity) throw new Error(oauthError ?? 'Sign-in was not completed.');
    }
  } catch (err) {
    history.replaceState(null, '', location.pathname);
    resetSocialButtons();
    const raw = err?.message ?? oauthError ?? '';
    toast(appleConfigErrorMessage(raw) ?? raw ?? 'Sign-in was not completed.');
    return false;
  }

  // Scrub the address bar so the code/tokens are not left in history.
  history.replaceState(null, '', location.pathname);

  // Identity MUST be the immutable provider subject id, never the email: an
  // email can be renamed or re-assigned, which would silently orphan the account.
  const providerId = identity.user_metadata?.sub
    ?? identity.user_metadata?.provider_id
    ?? identity.id;
  const email = identity.email ?? null;

  try {
    let user = await api.findByProvider('apple', providerId, 'appleId');
    if (!user && email) user = await api.fetchUserBy('email', email);

    // Done with the provider session — leaving it live would let a stale OAuth
    // session shadow the one we are about to mint.
    await supabase.auth.signOut().catch(() => {});

    if (user) {
      // Link the provider to an account created another way, so the next
      // sign-in resolves by id instead of falling back to email.
      if (!user.appleId) {
        await supabase.from('users').update({ appleId: providerId }).eq('id', user.id).select();
      }
      await signInExisting(user);
      return true;
    }

    resetSocialButtons();
    bounceToSignup('That Apple ID has no Meetfleet account yet.');
    return false;
  } catch (err) {
    resetSocialButtons();
    toast(err?.message ?? 'Could not complete that sign-in.');
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Boot
   ═══════════════════════════════════════════════════════════════════════════ */

setText('#brand-year', String(new Date().getFullYear()));

/**
 * Ambient brand video — decorative, so it must never cost the user anything
 * they did not ask for. Mirrors signup.js: reduced-motion, Save-Data and slow
 * links opt out, and playback pauses when the tab is hidden.
 */
function initBrandVideo() {
  const video = $('#brand-video');
  if (!video) return;

  const wantsLessMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const savingData = navigator.connection?.saveData === true;
  const slowLink = /(^|[^4])g$/.test(navigator.connection?.effectiveType ?? '');

  if (wantsLessMotion || savingData || slowLink) {
    video.remove();
    return;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) video.pause();
    else video.play().catch(() => { /* autoplay refused — poster is enough */ });
  });

  video.play().catch(() => { /* autoplay refused — poster is enough */ });
}

async function boot() {
  renderCountry();
  refreshIdentifier();
  initBrandVideo();

  // An OAuth return takes precedence over everything else on the page.
  if (new URLSearchParams(location.search).has('oauth')) {
    await resumeFromOAuth();
    return;
  }

  // Already signed in on this browser? Don't make them do it again.
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const stored = localStorage.getItem(USER_KEY);
    if (token && stored) {
      // Re-mint quietly: the stored Supabase session may have expired even
      // though our own token key is still present.
      api.startSession({ userId: token }).catch(() => {});
      location.replace(NEXT_URL);
    }
  } catch { /* storage disabled — just show the form */ }
}

boot();
