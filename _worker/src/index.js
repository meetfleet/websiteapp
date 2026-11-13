// Form handler for meetfleet.app/delete-account/.
//
// GitHub Pages can't run server code, so the page posts here. The Worker
// drops honeypot hits, rejects values the form can't produce, verifies the
// Turnstile token, and only then emails the request to support via Resend.
// Bots that POST here directly fail Turnstile.
//
// (It used to forward to FormSubmit, which answered every request from the
// Worker with 429 "Rate limit exceeded".)
//
// Secrets (wrangler secret put): TURNSTILE_SECRET_KEY, RESEND_API_KEY
// Vars (wrangler.toml):           ALLOWED_ORIGINS, TURNSTILE_HOSTNAMES, MAIL_FROM, MAIL_TO

// Must match the <option> values in delete-account/index.html exactly.
const DELETION_SCOPES = new Set([
  'Entire account and all personal data',
  'Specific data only (described below)',
]);

const CONFIRMATION = 'I understand this deletion is permanent and irreversible';
const HONEYPOT_FIELD = 'company_url';
const TURNSTILE_ACTION = 'delete-account';
const MAX_BODY_BYTES = 32 * 1024;

const LIMITS = { name: 200, email: 254, username: 100, message: 5000 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = list(env.ALLOWED_ORIGINS);
    const cors = allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};

    if (url.pathname !== '/delete-account') return json({ error: 'Not found' }, 404, cors);
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);
    if (!cors['Access-Control-Allow-Origin']) return json({ error: 'Forbidden' }, 403, cors);

    const length = Number(request.headers.get('Content-Length') || 0);
    if (length > MAX_BODY_BYTES) return json({ error: 'Request too large' }, 413, cors);

    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ error: 'Invalid form data' }, 400, cors);
    }

    const ticket = newTicketId();

    // Honeypot: answer exactly as a real success would, but send nothing.
    if (field(form, HONEYPOT_FIELD)) return json({ success: true, ticket }, 200, cors);

    const data = {
      name: field(form, 'name'),
      email: field(form, 'email'),
      username: field(form, 'username'),
      scope: field(form, 'scope'),
      message: field(form, 'message'),
      confirmation: field(form, 'confirmation'),
    };

    const invalid = validate(data);
    if (invalid) return json({ error: invalid }, 400, cors);

    const ip = request.headers.get('CF-Connecting-IP') || '';
    const human = await verifyTurnstile(field(form, 'cf-turnstile-response'), ip, env);
    if (!human) {
      return json({ error: 'Verification failed. Please try again.', retryTurnstile: true }, 403, cors);
    }

    const sent = await sendEmail(data, ticket, env);
    if (!sent) return json({ error: 'Could not send your request.' }, 502, cors);

    return json({ success: true, ticket }, 200, cors);
  },
};

function validate(d) {
  if (!d.name) return 'Please enter your full name';
  if (!EMAIL_RE.test(d.email)) return 'Enter a valid email address';
  if (!DELETION_SCOPES.has(d.scope)) return 'Please select what we should delete';
  if (d.confirmation !== CONFIRMATION) return 'Please confirm you understand this is permanent';
  for (const [key, max] of Object.entries(LIMITS)) {
    if (d[key].length > max) return `The ${key} field is too long`;
  }
  return null;
}

async function verifyTurnstile(token, ip, env) {
  if (!token || token.length > 2048) return false;

  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET_KEY);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const out = await res.json();
    if (!out.success) return false;
    if (out.action !== TURNSTILE_ACTION) return false;
    const hostnames = list(env.TURNSTILE_HOSTNAMES);
    return hostnames.length === 0 || hostnames.includes(out.hostname);
  } catch {
    return false;
  }
}

async function sendEmail(d, ticket, env) {
  // Plain text only, so nothing the requester typed is ever rendered as HTML.
  const text = [
    `Ticket:          ${ticket}`,
    'Request:         Permanent Data Deletion',
    `Name:            ${d.name}`,
    `Account email:   ${d.email}`,
    `Username/phone:  ${d.username || '-'}`,
    `Scope:           ${d.scope}`,
    `Confirmation:    ${d.confirmation}`,
    '',
    'Additional details:',
    d.message || '-',
    '',
    'Reply to this email to reach the requester.',
  ].join('\n');

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [env.MAIL_TO],
        reply_to: d.email,
        subject: `[Data Deletion Request ${ticket}] Meetfleet`,
        text,
      }),
    });
    if (res.ok) return true;
    console.error('Resend rejected the email', res.status, (await res.text()).slice(0, 500));
    return false;
  } catch (err) {
    console.error('Resend request failed', String(err));
    return false;
  }
}

function field(form, name) {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

function list(value) {
  return (value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function newTicketId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return '#MF-DEL-' + Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
