// Form handler for meetfleet.app/delete-account/.
//
// GitHub Pages can't run server code, so this Worker sits between the page
// and FormSubmit. It drops honeypot hits, rejects values the form can't
// produce, verifies the Turnstile token, and only then forwards a whitelisted
// set of fields to FormSubmit. Bots that POST here directly fail Turnstile.
//
// Secrets (wrangler secret put): TURNSTILE_SECRET_KEY, FORMSUBMIT_ENDPOINT
// Vars (wrangler.toml):           ALLOWED_ORIGINS, TURNSTILE_HOSTNAMES

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

    const sent = await forward(data, ticket, env);
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

async function forward(d, ticket, env) {
  const body = new FormData();
  body.append('_subject', `[Data Deletion Request ${ticket}] Meetfleet`);
  body.append('_template', 'table');
  body.append('_captcha', 'false');
  body.append('request_type', 'Permanent Data Deletion');
  body.append('ticket_id', ticket);
  for (const [key, value] of Object.entries(d)) body.append(key, value);

  try {
    // FormSubmit rejects requests with no Referer, so present the real page.
    const res = await fetch(env.FORMSUBMIT_ENDPOINT, {
      method: 'POST',
      body,
      headers: {
        Accept: 'application/json',
        Referer: 'https://meetfleet.app/delete-account/',
        Origin: 'https://meetfleet.app',
      },
    });
    if (!res.ok) return false;
    // FormSubmit can answer 200 with success "false" (e.g. activation pending).
    const out = await res.json();
    return out.success === true || out.success === 'true';
  } catch {
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
