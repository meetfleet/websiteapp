# Web signup — backend setup

The signup page at `/signup/` uses the same Supabase project as the mobile app.
Everything below was verified against the live project on 2026-08-05.

---

## 1. WhatsApp OTP — separate sessions per surface

The web signup sends its codes through **its own WhatsApp session** (`desktop`),
so the website and the app cannot take each other offline: if one number is
logged out or throttled by WhatsApp, the other keeps working.

| Surface | Session name    | Secret                |
| ------- | --------------- | --------------------- |
| Mobile  | `meetfleet-otp` | `OPENWA_SESSION`      |
| Web     | `desktop`       | `OPENWA_SESSION_WEB`  |

The client picks the lane by sending `platform: 'web'`; `wa-send-otp` resolves
the session name from that (see `pickSessionName()`). If `OPENWA_SESSION_WEB` is
unset, web silently falls back to the mobile session — i.e. exactly the old
behaviour, so this change is safe to deploy before the secret exists.

### Deploy

```bash
cd /Users/mac/ok/Neark/mobile

# The web session must already exist and be linked in OpenWA (status: ready).
supabase secrets set OPENWA_SESSION_WEB=desktop

supabase functions deploy wa-send-otp
```

### Verify

```bash
# Should deliver over the `desktop` session:
curl -s -X POST 'https://sbmeuhzmghaqkclaimid.supabase.co/functions/v1/wa-send-otp' \
  -H 'Content-Type: application/json' \
  -H 'apikey: sb_publishable_0Gf3FQtxmbXg5w-lxAWqKQ__5fJa-dY' \
  -d '{"phone":"+2126XXXXXXXX","platform":"web"}'
```

Failure logs now name the session (`session "desktop" not ready (status=…)`), so
it is immediately clear which number needs re-linking. Check `status` at
<https://wa.meetfleet.org> and re-scan the QR for that session.

**Note:** web has no SMS fallback — WhatsApp is the only phone channel there.
The function therefore returns web-specific copy ("…or use email instead")
rather than the `fallback: 'sms'` hint the app acts on. `wa-verify-otp` needs no
change: it verifies against `phone_otp_codes`, not the gateway, so it is
session-agnostic.

---

## 2. Google sign-in — FIXED IN CODE

**Symptom:** the button span forever and nothing happened.

**Cause:** the Supabase JS client uses the **PKCE** flow, so the callback comes
back as `?code=…` and must be *exchanged* for a session. The page was calling
`getSession()`, which returns `null` there, so the code fell through silently
and the spinner never cleared.

**Fix:** `resumeFromOAuth()` now calls `exchangeCodeForSession(code)` (and still
accepts implicit-flow `#access_token=` callbacks), surfaces provider errors, and
always clears the spinner. A 6-second watchdog also releases the button if the
redirect never starts.

The provider config itself is fine — verified that
`/auth/v1/authorize?provider=google` 302s to a working Google consent screen.

### Still to do in the dashboard

Add the production origins under **Authentication → URL Configuration →
Redirect URLs**, or the callback will be rejected once deployed:

```
https://meetfleet.app/signup/
https://meetfleet.app/signup/**
```

---

## 3. Apple sign-in — NEEDS DASHBOARD WORK

**Symptom:** Apple's page shows an error instead of the sign-in prompt.

**Cause (confirmed):** the authorize endpoint returns

```json
{"errorMessage":"Invalid client id or web redirect url.","errorCode":"invalid_request"}
```

because the configured `client_id` is **`com.meetfleet.mobile`** — the *iOS
bundle ID*. Sign in with Apple on the web requires a separate **Services ID**;
Apple rejects a native app identifier for web authorization. No amount of
front-end code can work around this.

### To fix

1. **Apple Developer → Certificates, IDs & Profiles → Identifiers**
   - Create a **Services ID**, e.g. `com.meetfleet.web`.
   - Enable *Sign in with Apple* on it, then **Configure**:
     - Primary App ID: `com.meetfleet.mobile`
     - Domains: `meetfleet.app`
     - Return URLs: `https://sbmeuhzmghaqkclaimid.supabase.co/auth/v1/callback`
2. **Keys** → create a *Sign in with Apple* key, download the `.p8`.
3. **Supabase → Authentication → Providers → Apple**
   - Client IDs: add `com.meetfleet.web` **alongside** `com.meetfleet.mobile`
     (the field is a comma-separated list — keep the bundle ID or iOS logins
     break).
   - Secret Key: the generated `.p8` JWT.
4. Verify the domain with the file Apple provides, if prompted.

Until then the page fails gracefully: it detects the `invalid_client` response
and tells the user "Apple sign-in is not available on the web yet. Please use
email, phone or Google" instead of stranding them.

Consider hiding the Apple button until step 3 is done:

```js
// signup.js — near the boot block
if (!APPLE_WEB_ENABLED) hide($('#btn-apple').parentElement);
```

---

## 4. Error surfacing — FIXED IN CODE

`supabase.functions.invoke()` throws a `FunctionsHttpError` whose `.message` is
always the useless string *"Edge Function returned a non-2xx status code"* — the
real text sits unread in the response body. Every gateway problem therefore
reached users as the same opaque sentence.

`readFunctionError()` now reads `error.context.json()` and surfaces the actual
message ("This number is not on WhatsApp…", "Too many codes requested…").

---

## 5. Database

See [`setup.sql`](setup.sql). Sections 0–4 are additive and safe to run now.

Section 5 (RLS tightening) is intentionally commented out: `public.users`
currently has `FOR ALL USING (true)`, which lets anyone holding the publishable
key read every column — `password_hash` included — and write freely. That risk
already exists with the key in the app binary, but a public web page makes it
far easier to find. The app must move its direct `users` reads onto RPCs before
that section can be applied.
