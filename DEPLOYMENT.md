# Deployment & domain routing

## Host

This site is served by **GitHub Pages** from the `main` branch. The custom
domain is set by the `CNAME` file (`meetfleet.app`).

GitHub Pages serves static files only. It does **not** interpret `vercel.json`,
`_redirects`, or `.htaccess` — those files were previously in this repo but did
nothing, and were served publicly as plain text. Don't re-add them unless the
site actually moves to Vercel, Netlify, or Apache.

Consequences worth knowing:

- No server-side rewrites, redirects, or custom headers.
- No host-based routing — Pages serves one custom domain per repo, so a
  subdomain cannot be routed to a subdirectory from inside this repo.
- Cache-control and security headers are whatever GitHub sets.

## Subdomains

Subdomains are handled entirely in **Namecheap URL Forwarding**, not here.

| Subdomain            | Forwards to                        |
| -------------------- | ---------------------------------- |
| `chat.meetfleet.app` | `https://meetfleet.app/messages/`   |

Namecheap forwarding answers on its own IP and issues a 302 to the destination.

**Forwarding records need SSL enabled in Namecheap.** Without it the subdomain
has no certificate, so `https://chat.meetfleet.app` fails to connect before the
redirect can run — and browsers try HTTPS first. Enable the free SSL option on
the redirect record in Namecheap → Domain List → Manage → Redirect Domain.

To verify a forward end to end:

```sh
curl -sI -L http://chat.meetfleet.app | head    # should 302 to the destination
curl -sI    https://chat.meetfleet.app | head   # empty output = SSL not enabled
```

## Form handler (Cloudflare Worker)

The data deletion form (`/delete-account/`) posts to a Cloudflare Worker in
`_worker/` (live at `https://meetfleet-forms.meetfleet-forms.workers.dev`).
Pages can't run server code, so the Worker does the checks a backend would:

- drops submissions that fill the hidden `company_url` honeypot, while still
  answering with a normal success response;
- rejects any `scope` that isn't one of the form's real options (the
  placeholder "Select a deletion scope" included). The allowed values are
  `DELETION_SCOPES` in `_worker/src/index.js` and must match the
  `<option>` values in `delete-account/index.html`;
- verifies the Cloudflare Turnstile token with Cloudflare, so a bot that
  POSTs straight to the Worker is turned away;
- emails the request as plain text to `support@meetfleet.app` through
  [Resend](https://resend.com), with Reply-To set to the requester.

It used to forward to FormSubmit, but FormSubmit answered every request from
the Worker with 429 "Rate limit exceeded".

`_worker/` starts with an underscore, so Jekyll (which GitHub Pages runs) leaves
it out of the published site. Don't add a `.nojekyll` file, or the folder
becomes public.

### Setup

1. **Turnstile:** Cloudflare dashboard → Turnstile → Add widget. Hostname
   `meetfleet.app`, mode **Managed**. Most visitors never see it, and the rare
   suspicious one gets a single checkbox. Keep the site key and the secret key.
2. **Resend:** sign up at resend.com **with `support@meetfleet.app`**. Until
   meetfleet.app is verified in Resend, mail is sent from
   `onboarding@resend.dev`, and Resend only delivers that to the account's own
   address. Create an API key with sending access. Free plan: 100 emails/day.
3. **Deploy the Worker and set its secrets:**

   ```sh
   cd _worker
   npx wrangler login
   npx wrangler deploy        # prints https://meetfleet-forms.<you>.workers.dev
   npx wrangler secret put TURNSTILE_SECRET_KEY
   npx wrangler secret put RESEND_API_KEY
   ```

   Until both secrets are set, the Worker refuses every submission. It never
   lets one through unchecked.

4. **Point the page at it:** in `delete-account/index.html`, set the form
   `action` to `https://meetfleet-forms.<you>.workers.dev/delete-account` and
   `data-sitekey` on `#turnstile-slot` to the Turnstile site key.
5. Push the site, then send one real request and check the support inbox.

If a submission fails, Workers → meetfleet-forms → Logs (or
`npx wrangler tail`) shows the reason Resend gave.

**Sending from your own domain (optional):** add meetfleet.app under Resend →
Domains, create the DNS records it lists in Namecheap, and once it shows
Verified, change `MAIL_FROM` in `_worker/wrangler.toml` to an address on
meetfleet.app (e.g. `Meetfleet Forms <forms@meetfleet.app>`) and redeploy.

Tests: `cd _worker && npm test` (Node 18+, no install needed).

The support form (`/support/`) still posts directly to FormSubmit and isn't
covered by these checks yet.
