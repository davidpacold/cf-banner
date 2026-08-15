# cf-banner

A Cloudflare Snippet that injects a site-wide notice banner into HTML
responses, plus a one-command CLI to change what it says.

It is deployed against `airiaazure.davidpacold.com`, and the design notes below
are specific to that app — but the three problems it solves are general to
injecting anything at the edge:

- **Conditional requests defeat edge injection.** A `304` has no body to
  rewrite, so returning visitors keep a cached, un-injected page — potentially
  forever. [Why, and the fix.](#caching-why-conditional-requests-are-defeated)
- **Charset sniffing mangles non-ASCII.** An origin serving `text/html` with no
  charset gets sniffed as `windows-1252`, so an injected em dash renders as
  `â€"`. [The escaping fix.](#design)
- **`100vh` app shells overflow when you push content down.** Body padding is
  not enough. [The layout offset.](#the-layout-coupling)

## Configure it for your site

| What | Where | Default |
|---|---|---|
| Hostname | `HOSTNAME_TARGET` env | `airiaazure.davidpacold.com` |
| Zone | `ZONE_NAME` env | `davidpacold.com` |
| Snippet name | `SNIPPET_NAME` env | `cf_banner` |
| App shell selector | `APP_ROOT_SELECTOR` in `snippet.js` | `#root` |
| Reserved height | `BANNER_HEIGHT` in `snippet.js` | `40px` |

The colours come from the host app's CSS custom properties (see
[Design](#design)); point `LEVELS` in `snippet.js` at your own tokens, or
replace them with literal values.

## Changing the message

```bash
./banner "Scheduled maintenance tonight, 10pm-11pm ET"
./banner --level critical "Sign-in is degraded. We are on it."
./banner --off        # hide it, keep the message
./banner --on         # show it again
./banner --status     # what is in the file, and what the site is actually serving
```

That is the whole workflow. `./banner` rewrites the message in `snippet.js`,
deploys, then reads the live page back and only reports success once the new
text is actually being served.

**One-time setup** — store the token so you never think about it again:

```bash
security add-generic-password -s cf-banner-cloudflare-token -a "$USER" -w
```

Paste a Cloudflare API token at the prompt. `CLOUDFLARE_API_TOKEN` in the
environment overrides the Keychain for one-off runs and CI.

Editing `MESSAGE` and `LEVEL` in `snippet.js` by hand and running `./deploy.sh`
does exactly the same thing — `./banner` is a convenience, not a layer.

```
snippet.js            the Snippet itself (this is what you deploy)
banner                shim -> tools/banner_cli.py
deploy.sh             shim -> tools/cf.py deploy
tools/banner_cli.py   the ./banner command: edit, deploy, verify, toggle
tools/cf.py           every Cloudflare API call, in one place
tools/config.py       reads and writes the MESSAGE / LEVEL lines safely
test/harness.js       runs snippet.js under workerd against the live origin
test/preview.mjs      renders the banner over a stand-in page for visual checks
```

Both entry points are thin shells over Python. Cloudflare calls live only in
`tools/cf.py`, so `deploy.sh` and `./banner` cannot drift apart in how they
authenticate, merge rules, or interpret an error response.

## How it works

`fetch` goes to the origin, and HTML document responses get the banner
prepended to `<body>` via `HTMLRewriter`. Non-HTML responses, non-2xx
responses, and subresource requests (`Sec-Fetch-Dest` other than `document`)
pass through untouched.

## Design

This bar carries important notices only, so the treatment is built to be read
rather than to blend in.

- **Colors are the host app's own tokens.** Airia defines ~118 shadcn-style HSL
  triplets on `:root`, and they are in scope for injected markup. `LEVEL`
  selects a severity that maps onto them — `important` uses the `caution`
  family, `critical` uses `destructive`. The banner tracks any theme change for
  free, and severity reads the same here as it does inside the product.
- **The fill is the saturated token, not the pale `-background` variant.** A
  soft wash reads as ambient chrome that people learn to skip.
- **Text is `--foreground`, not `--caution-foreground`.** The app's own pairing
  measures 4.38:1 on the saturated fill, under the 4.5:1 AA floor for 14px
  text. `--foreground` measures 8.31:1, verified on the live page.
- **Type is inherited**, so the banner picks up Figtree from `body` with no
  font loading of its own.
- **Text is escaped to pure ASCII.** The origin sends `content-type: text/html`
  with no charset parameter and the document is otherwise all ASCII, so
  browsers sniff it as `windows-1252` (confirmed: `document.characterSet`
  reports exactly that). Raw UTF-8 for an em dash renders as `â€"`, so every
  non-ASCII character is emitted as a numeric reference instead. Punctuation,
  accents and emoji in a message all survive without touching the origin's
  own encoding.
- **Dismissal is CSS-only** — a visually-hidden checkbox plus a sibling
  selector, no inline JavaScript. The origin sends a `Content-Security-Policy`
  header, so a banner depending on inline script would be one `script-src`
  directive away from breaking. The checkbox stays focusable and carries an
  `aria-label`, so it is keyboard-operable and announced.
- **Content is pushed down, not covered** (`PUSH_CONTENT = true`), because the
  Airia logo sits in the top-left. See the layout note below.

### The layout coupling

`APP_ROOT_SELECTOR` is the one place this Snippet knows anything about the
app's markup. Padding `body` alone is not enough — the shell and its inner
Tailwind `h-screen` container are both `100vh`, so the document ends up 40px
taller than the viewport and the foot of the sidebar drops below the fold. A
single `--cf-banner-offset` variable drives the body padding and the height
overrides together, so dismissing the banner flips one value instead of
restoring each rule.

If a rebuild renames `#root` or stops using `h-screen`, the symptom is a 40px
scrollbar, not a broken page. Set `PUSH_CONTENT = false` to fall back to a
floating banner that touches no app layout at all.

## Caching: why conditional requests are defeated

The origin serves `index.html` with `Cache-Control: no-cache` and a static
`ETag`. A returning browser therefore revalidates on every navigation, and the
origin answers `304 Not Modified` — a response with **no body**. There is
nothing for `HTMLRewriter` to inject into, so the browser falls back to its
cached copy of the page, which predates the Snippet. Because the origin's ETag
is derived from a file that never changes, that stale copy would win *forever*,
not just once. This is exactly what happened on first deploy: the HTML on the
wire had the banner, but Chrome rendered a 304 and showed nothing.

So the Snippet strips `If-None-Match` / `If-Modified-Since` from navigation
requests, forcing a full `200` it can rewrite, and strips `ETag` /
`Last-Modified` from the injected response so no downstream cache validates
against content that no longer matches.

**The tradeoff:** navigations now transfer the full ~52 KB shell instead of a
304. The page was already revalidating every time (`no-cache`), so this costs
one body transfer per navigation, not a new round trip. Remove the stripping if
you'd rather have 304s back and accept that cached clients never see the banner.

## Prerequisites

The hostname must be **proxied** (orange cloud) in Cloudflare DNS. Snippets only
run on proxied traffic; a DNS-only record goes straight to the origin and the
Snippet never executes. Verify:

```bash
curl -sI https://airiaazure.davidpacold.com/ | grep -i '^server\|cf-ray'
# want: server: cloudflare  +  a cf-ray header
```

## Deploy

Needs an API token with **Zone → Snippets → Edit** on the zone.

```bash
export CLOUDFLARE_API_TOKEN=...
./deploy.sh
```

Two things that cost real debugging time here:

**Snippets is its own permission.** A token with Workers, Pages, DNS and Zone
*read* still gets `code 10000 Authentication error` from every `/snippets`
endpoint. Zone read is not enough.

**Account-owned and user-owned tokens live in different places.** A `cfat_`
token is account-owned: it is managed under *Manage Account → API Tokens*, not
*My Profile → API Tokens*, and `GET /user/tokens/verify` reports it as
`Invalid API Token` even when it is valid — use
`GET /accounts/{account_id}/tokens/verify` instead. Editing an account token's
permissions from the My Profile page silently does nothing, because the token
listed there is a different one.

`deploy.sh` uploads the Snippet, then merges its rule into the zone's existing
snippet rules. The merge matters: the `snippet_rules` endpoint is a full `PUT`
replacement, so writing the rule list blindly would delete every other snippet
rule on the zone.

Or paste `snippet.js` into the dashboard by hand: **Rules → Snippets → Create
Snippet**, name `cf_banner`, filter expression:

```
http.host eq "airiaazure.davidpacold.com"
```

## Verify

```bash
curl -s https://airiaazure.davidpacold.com/ | grep cf-banner
```

## Local development

```bash
npm run dev      # workerd + the real origin on localhost:8787
npm run preview  # writes test/preview.html for a visual check
```

Note that the app redirects unauthenticated visitors to Keycloak SSO on
`azureidentity.davidpacold.com`, which is a different hostname and therefore
outside this Snippet's rule. Log in first when checking the banner in a browser,
or widen the expression to cover the identity host too.
