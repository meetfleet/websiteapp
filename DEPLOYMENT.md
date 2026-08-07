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
