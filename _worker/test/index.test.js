import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const ENV = {
  ALLOWED_ORIGINS: 'https://meetfleet.app',
  TURNSTILE_HOSTNAMES: 'meetfleet.app',
  TURNSTILE_SECRET_KEY: 'secret',
  RESEND_API_KEY: 're_test',
  MAIL_FROM: 'Meetfleet Forms <onboarding@resend.dev>',
  MAIL_TO: 'support@meetfleet.app',
};

const VALID = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  username: '@ada',
  scope: 'Entire account and all personal data',
  message: 'Please delete everything.',
  confirmation: 'I understand this deletion is permanent and irreversible',
  'cf-turnstile-response': 'token',
};

let calls;
let siteverify;
let resend;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  siteverify = { success: true, action: 'delete-account', hostname: 'meetfleet.app' };
  resend = { status: 200, body: { id: 'email_123' } };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('siteverify')) return Response.json(siteverify);
    return Response.json(resend.body, { status: resend.status });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function post(fields, { origin = 'https://meetfleet.app', path = '/delete-account' } = {}) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  const headers = origin ? { Origin: origin } : {};
  return worker.fetch(new Request(`https://forms.example${path}`, { method: 'POST', body, headers }), ENV);
}

const RESEND_URL = 'https://api.resend.com/emails';
const forwarded = () => calls.filter(c => c.url === RESEND_URL);
const sentEmail = () => JSON.parse(forwarded().at(-1).init.body);

test('valid submission is verified and emailed', async () => {
  const res = await post(VALID);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.success, true);
  assert.match(out.ticket, /^#MF-DEL-[A-Z2-9]{6}$/);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://meetfleet.app');

  assert.equal(forwarded().length, 1);
  const call = forwarded()[0];
  assert.equal(call.init.headers.Authorization, 'Bearer re_test');
  const email = sentEmail();
  assert.equal(email.from, ENV.MAIL_FROM);
  assert.deepEqual(email.to, ['support@meetfleet.app']);
  assert.equal(email.reply_to, VALID.email);
  assert.equal(email.subject, `[Data Deletion Request ${out.ticket}] Meetfleet`);
  assert.match(email.text, /Scope: +Entire account and all personal data/);
  assert.match(email.text, /Username\/phone: +@ada/);
  assert.ok(!email.text.includes('token'), 'Turnstile token is not emailed');
  assert.equal(email.html, undefined, 'plain text only');
});

test('honeypot hit looks like success but sends nothing', async () => {
  const res = await post({ ...VALID, company_url: 'https://spam.example' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).success, true);
  assert.equal(calls.length, 0, 'neither Turnstile nor Resend is called');
});

test('placeholder and unknown scopes are rejected', async () => {
  for (const scope of ['', 'Select a deletion scope', 'anything else']) {
    const res = await post({ ...VALID, scope });
    assert.equal(res.status, 400, `scope "${scope}"`);
  }
  assert.equal(calls.length, 0);
});

test('missing or wrong confirmation is rejected', async () => {
  const { confirmation, ...rest } = VALID;
  assert.equal((await post(rest)).status, 400);
  assert.equal((await post({ ...VALID, confirmation: 'yes' })).status, 400);
  assert.equal(calls.length, 0);
});

test('bad email and oversized fields are rejected', async () => {
  assert.equal((await post({ ...VALID, email: 'not-an-email' })).status, 400);
  assert.equal((await post({ ...VALID, message: 'x'.repeat(5001) })).status, 400);
  assert.equal(calls.length, 0);
});

test('missing Turnstile token is rejected without forwarding', async () => {
  const { 'cf-turnstile-response': _, ...rest } = VALID;
  const res = await post(rest);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).retryTurnstile, true);
  assert.equal(forwarded().length, 0);
});

test('failed, wrong-action, or wrong-host Turnstile results are rejected', async () => {
  for (const result of [
    { success: false },
    { success: true, action: 'support', hostname: 'meetfleet.app' },
    { success: true, action: 'delete-account', hostname: 'evil.example' },
  ]) {
    siteverify = result;
    assert.equal((await post(VALID)).status, 403, JSON.stringify(result));
  }
  assert.equal(forwarded().length, 0);
});

test('requests from other origins are refused', async () => {
  assert.equal((await post(VALID, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(VALID, { origin: null })).status, 403);
  assert.equal(calls.length, 0);
});

test('email failure surfaces as an error, not success', async () => {
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    resend = { status: 429, body: { name: 'daily_quota_exceeded' } };
    assert.equal((await post(VALID)).status, 502);
    resend = { status: 403, body: { name: 'validation_error' } };
    assert.equal((await post(VALID)).status, 502);
  } finally {
    console.error = realError;
  }
  assert.equal(errors.length, 2);
  assert.match(errors[0], /Resend rejected the email 429 .*daily_quota_exceeded/);
});

test('other paths and methods are refused', async () => {
  assert.equal((await post(VALID, { path: '/' })).status, 404);
  const get = await worker.fetch(new Request('https://forms.example/delete-account', { headers: { Origin: 'https://meetfleet.app' } }), ENV);
  assert.equal(get.status, 405);
});
