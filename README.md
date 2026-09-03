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
| Dismissal memory | `DISMISS_DAYS` in `snippet.js` | `7` |

The colours come from the host app's CSS custom properties (see
[Design](#design)); point `LEVELS` in `snippet.js` at your own tokens, or
replace them with literal values.

## Changing the message

```bash
./banner "Scheduled maintenance tonight, 10pm-11pm ET"
./banner --level critical "Sign-in is degraded. We are on it."
./banner --off        # hide it, keep the message
./banner --on         # show it again, including to people who dismissed it
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
environment overrides the Keychain for one-off runs and CI. If the interactive
prompt does not take the paste it stores an *empty* item, so pass the value
inline instead: `security add-generic-password -U -s cf-banner-cloudflare-token
-a "$USER" -w 'TOKEN'` (`-U` overwrites; without it the add fails as a
duplicate). An empty item is reported as such rather than being sent as
`Bearer ` and coming back as an opaque Cloudflare header error.

`./banner --status` needs no token at all — it reads `snippet.js` and fetches
the public page, and never calls the Cloudflare API.

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
responses, and subresource requests pass through untouched.

A request is a navigation when `Sec-Fetch-Dest` is `document`. Clients that
predate Fetch Metadata (Safari before 16.4, curl, monitoring probes) send that
header on nothing at all, so for those the `Accept` header decides: browsers
ask for `text/html` when fetching a document and for something narrower
otherwise. A caller sending no `Accept` is passed through rather than assumed
to be a navigation. This is why the verify command below sets `Accept` — a
bare `curl` sends only a wildcard and is treated as a subresource.

Getting this wrong is expensive in both directions. Treating every
header-less request as a navigation strips cache validators from every asset
those clients fetch — a full bundle re-download per page load — and splices a
banner into any `text/html` fragment the SPA pulls over XHR.

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
  selector. The origin sends a `Content-Security-Policy` header, so a banner
  depending on inline script to *hide itself* would be one `script-src`
  directive away from breaking. As observed on 2026-09-01 that header is
  `frame-ancestors 'self' https://airiaazure.davidpacold.com;` with **no
  `script-src` directive**, so inline script does run today — recorded here so
  that a future tightening at the origin is recognised as breaking the
  persistence below rather than looking like a mystery. The checkbox stays focusable and carries an
  `aria-label`, so it is keyboard-operable and announced.
- **Dismissal is remembered for `DISMISS_DAYS`** (7) by a small inline script
  that only ticks the checkbox on a later visit — the CSS above is still what
  hides the bar. If a `script-src` directive ever blocks that script, dismissal
  degrades to lasting one page view; nothing breaks. The record lives in
  `localStorage` under `cf-banner-dismissed` and is keyed to a hash of the
  message, level and `DISMISS_EPOCH`, so **deploying new text re-shows the
  banner immediately**, even for someone who dismissed the previous notice an
  hour ago — a stale dismissal must never suppress a fresh outage notice. Set
  `DISMISS_DAYS = 0` to drop the script and go back to per-page-view dismissal.

  `./banner --on` sets `DISMISS_EPOCH` to the current Unix time and redeploys,
  so it re-shows the bar to people who already dismissed it. It is seeded from
  the clock rather than incremented, because a counter lives in whichever
  working tree last ran the command and is not committed — two operators
  deploying from clean checkouts would both write the same next value and ship
  an identical key, reintroducing the suppression the epoch exists to prevent. That is what makes `--off` when an
  incident clears and `--on` when it recurs work: the message is deliberately
  unchanged across that cycle, so without the epoch the second notice would be
  invisible to exactly the audience that saw the first. (`--off` still only
  toggles the rule.)

  The age check is bounded below as well as above. A device whose clock is
  running ahead writes a future timestamp, and an upper-bound-only test would
  read that as "dismissed" forever, even after the clock is corrected.

  A remembered dismissal also takes the checkbox out of the tab order
  (`.cf-banner-toggle:checked { display: none }`). Hiding the banner hides this
  control's only visible affordance *and* its focus ring, so leaving it
  focusable would strand a keyboard user on an invisible checkbox that
  re-opens the bar and wipes the stored dismissal.

  Every storage call is guarded: Safari's private mode and "block all cookies"
  throw on the `window.localStorage` property access itself, and that must not
  take the banner down with it. `localStorage` rather than a cookie because
  setting a cookie would need the same inline script anyway, and would add a
  header to every origin request.
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
rule on the zone. The rule is replaced **in place** rather than re-appended,
because snippet rules are first-match-wins — moving ours to the end would let
a broader rule that used to sit behind it start winning, and the banner would
quietly stop running.

Scoping added by hand in the dashboard survives a deploy: if the existing
rule's expression still names the target host, its expression and description
are kept. Repointing `HOSTNAME_TARGET` leaves the old host in the expression,
which is what allows that setting to take effect.

Or paste `snippet.js` into the dashboard by hand: **Rules → Snippets → Create
Snippet**, name `cf_banner`, filter expression:

```
http.host eq "airiaazure.davidpacold.com"
```

## Verify

```bash
curl -s -H 'Accept: text/html' https://airiaazure.davidpacold.com/ | grep cf-banner
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
