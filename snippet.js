/**
 * Cloudflare Snippet: inject a site-wide banner into HTML responses.
 *
 * Target: airiaazure.davidpacold.com
 *
 * To change what the banner says, run:  ./banner "Your message here"
 * That edits the block below and deploys. Editing it by hand and running
 * ./deploy.sh does exactly the same thing.
 *
 * Design notes:
 *  - Dismissal is pure CSS (visually-hidden checkbox + sibling selector), so
 *    it survives any script-src Content-Security-Policy the origin sets. An
 *    inline script only *remembers* the dismissal for DISMISS_DAYS; if that
 *    script is ever blocked, dismissal simply stops persisting.
 *  - Only document responses are rewritten, so HTML fragments the SPA fetches
 *    via XHR/fetch never get a banner spliced into them.
 */

// ===========================================================================
// THE MESSAGE  —  the two lines below are what you normally change.
// `./banner` rewrites them verbatim, so keep them one-per-line and quoted.
// ===========================================================================

/** Text shown in the banner. */
const MESSAGE = "Test from Cloudflare!";

/** Severity: "important" (amber) or "critical" (red). See LEVELS below. */
const LEVEL = "important";

// ===========================================================================
// Everything below is behaviour and styling.
// ===========================================================================

/**
 * Severity drives a real difference in treatment rather than decoration.
 * "important" is the default voice; "critical" is reserved for outages and
 * data risk. Overusing the top level is how a banner stops being read.
 *
 * Each level maps onto the host app's own semantic tokens, so severity reads
 * the same here as it does inside the product.
 *
 * Note the text colour: the app pairs --caution with --caution-foreground,
 * but that combination measures 4.38:1 against the saturated fill, under the
 * 4.5:1 AA floor for 14px text. --foreground on the same fill measures 8.4:1.
 */
const LEVELS = {
  important: {
    fill: "hsl(var(--caution, 38 92% 50%))",
    text: "hsl(var(--foreground, 240 6% 10%))",
    rule: "hsl(var(--caution-hover, 32 95% 44%))",
  },
  critical: {
    fill: "hsl(var(--destructive, 0 74% 42%))",
    text: "hsl(var(--destructive-foreground, 0 86% 97%))",
    rule: "hsl(var(--destructive-active, 0 63% 31%))",
  },
};

// Falling back keeps a mistyped LEVEL from emitting `background: undefined`
// and rendering the notice invisible. ./banner validates the value; editing
// snippet.js by hand does not.
const THEME = LEVELS[LEVEL] || LEVELS.important;

/**
 * Lucide's triangle-alert, inlined. The app's own iconography is Lucide, and
 * inlining keeps this within the origin's CSP — no external request to block.
 */
const ICON = `<svg class="cf-banner__icon" viewBox="0 0 24 24" width="18" height="18" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>
  <path d="M12 9v4"/><path d="M12 17h.01"/>
</svg>`;

/**
 * true:  page content is pushed down by BANNER_HEIGHT, so the banner covers
 *        nothing (the Airia logo sits in the top-left and was being clipped).
 * false: banner floats over the page and the app's layout is untouched.
 *
 * If MESSAGE ever grows long enough to wrap, raise BANNER_HEIGHT to match —
 * the reserved space is a fixed value, the banner itself is not.
 */
const PUSH_CONTENT = true;

const BANNER_HEIGHT = "40px";

/**
 * How long a dismissal is remembered. Set to 0 to go back to dismissal that
 * lasts only for the current page view.
 *
 * The record is keyed to the message, so deploying new text re-shows the
 * banner even for someone who dismissed the previous one an hour ago. A stale
 * dismissal must never suppress a fresh notice.
 */
const DISMISS_DAYS = 7;

/**
 * Bumped to re-show the banner to people who already dismissed it.
 *
 * The dismissal key is derived from the message, so new text re-shows itself
 * for free. This covers the case where the text is deliberately unchanged:
 * `./banner --off` when an incident clears, then `--on` when it recurs the
 * next day, would otherwise be invisible to exactly the people who saw the
 * first notice. `./banner --on` bumps this and redeploys.
 */
const DISMISS_EPOCH = 1788464231;

/**
 * The app shell. Padding the body alone is not enough: the shell and its
 * inner Tailwind `h-screen` container both stay 100vh tall, so the document
 * ends up 40px taller than the viewport and the foot of the sidebar drops
 * below the fold. Shrinking them by the offset keeps the app exactly one
 * screen tall.
 *
 * This is the one place the Snippet knows anything about the app's markup.
 * If a rebuild renames #root or stops using h-screen, the symptom is a 40px
 * scrollbar, not a broken page — set PUSH_CONTENT = false to fall back to a
 * floating banner. Set this to null if the app is not full-height.
 */
const APP_ROOT_SELECTOR = "#root";

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

// Declared above MARKUP because escapeHtml runs while MARKUP is being built,
// and a const is not initialised until its declaration is evaluated.
const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

const LAST_ASCII = 126;

/**
 * Identifies this exact notice, so a dismissal cannot carry over to the next
 * one. Changes whenever the message, the level, or DISMISS_EPOCH does — the
 * first two automatically, the third when an operator asks for a re-show.
 */
const DISMISS_ID = hash(`${MESSAGE}\n${LEVEL}\n${DISMISS_EPOCH}`);

/**
 * Remembers a dismissal for DISMISS_DAYS. Progressive enhancement only: the
 * checkbox above is what actually hides the banner, and this just restores
 * its state on a later visit. If a script-src directive ever blocks this,
 * the banner degrades to dismissal that lasts one page view.
 *
 * localStorage rather than a cookie: setting a cookie would need this same
 * script anyway, and would add a header to every origin request.
 */
const DISMISS_SCRIPT = `
<script>
(function () {
  // Inline script blocks the parser, so the box is ticked before the browser
  // has anything to paint: no flash of a banner that is about to vanish.
  var box = document.getElementById("cf-banner-dismiss");
  if (!box) return;

  var KEY = "cf-banner-dismissed";
  var ID = "${DISMISS_ID}";
  var TTL = ${DISMISS_DAYS} * 86400000;

  // Safari's private mode and "block all cookies" throw on the property
  // access itself rather than handing back an unusable object, so even
  // reaching storage has to be guarded.
  var store;
  try {
    store = window.localStorage;
  } catch (e) {
    return;
  }

  function dismissalIsLive(saved) {
    if (!saved || saved.id !== ID) return false;
    // Bounded below as well as above. A device whose clock is running ahead
    // writes a future "at", and a negative age would satisfy an
    // upper-bound-only test forever — suppressing the banner permanently,
    // even once the clock is corrected. NaN fails both comparisons, so a
    // malformed "at" shows the banner rather than hiding it.
    var age = Date.now() - saved.at;
    return age >= 0 && age < TTL;
  }

  try {
    // getItem returns null when unset, and JSON.parse(null) is null, so a
    // first visit falls through without throwing.
    //
    // Assigned unconditionally, never only-when-true: browsers restore form
    // control state across a reload, so a box left checked by a dismissal that
    // has since expired would come back checked and keep the banner hidden
    // past its window. Storage is the single source of truth. (autocomplete=off
    // on the input asks for the same thing declaratively, for the case where
    // this script is blocked.)
    box.checked = dismissalIsLive(JSON.parse(store.getItem(KEY)));
  } catch (e) {
    // Corrupt record: show the banner. The next dismissal overwrites it.
    box.checked = false;
  }

  box.addEventListener("change", function () {
    try {
      if (box.checked) {
        store.setItem(KEY, JSON.stringify({ id: ID, at: Date.now() }));
      } else {
        // Unreachable while a live dismissal takes the control out of the tab
        // order (see the CSS above) — kept so the handler stays correct if a
        // visible "show again" affordance is ever added.
        store.removeItem(KEY);
      }
    } catch (e) {
      // Storage full or denied. Dismissal still works for this page view.
    }
  });
})();
</script>`;

// Exported so preview.mjs can render the exact same banner locally. The
// Snippets runtime only ever calls the default export.
export const MARKUP = `
<input type="checkbox" id="cf-banner-dismiss" class="cf-banner-toggle" aria-label="Dismiss notice" autocomplete="off">
<div class="cf-banner" role="region" aria-label="Important notice">
  ${ICON}
  <span class="cf-banner__text">${escapeHtml(MESSAGE)}</span>
  <label class="cf-banner__close" for="cf-banner-dismiss" title="Dismiss">&times;</label>
</div>
<style>
  /*
   * Colors come from the host app's own token set (shadcn-style HSL triplets
   * on :root) so the banner tracks its theme instead of competing with it.
   * Fallbacks cover the case where the stylesheet has not applied.
   *
   * The fill is the saturated token rather than the pale -background variant:
   * this bar only ever carries messages that must be read, and a soft wash
   * reads as ambient chrome people learn to skip.
   */
  .cf-banner {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    box-sizing: border-box;
    min-height: ${BANNER_HEIGHT};
    /* 44px inline padding keeps centred text clear of the close control on
       narrow viewports, where the two used to overlap. */
    padding: 8px 44px;
    background: ${THEME.fill};
    color: ${THEME.text};
    border-bottom: 1px solid ${THEME.rule};
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.35;
    text-align: center;
  }
  .cf-banner__icon {
    flex: none;
  }
  .cf-banner__close {
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    cursor: pointer;
    padding: 0 6px;
    font-size: 20px;
    line-height: 1;
    opacity: 0.7;
    user-select: none;
  }
  .cf-banner__close:hover { opacity: 1; }

  /*
   * Visually hidden but still focusable and announced. The hidden attribute
   * used previously took the checkbox out of the tab order entirely, which
   * left the banner impossible to dismiss without a pointer.
   */
  .cf-banner-toggle {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .cf-banner-toggle:focus-visible ~ .cf-banner .cf-banner__close {
    outline: 2px solid hsl(var(--ring, 240 6% 10%));
    outline-offset: 2px;
    border-radius: 4px;
    opacity: 1;
  }
  .cf-banner-toggle:checked ~ .cf-banner { display: none; }

  /*
   * Hiding the banner also hides this control's only visible affordance and
   * its focus ring (which is drawn on the close button, inside the banner),
   * so the checkbox has to leave the tab order with it. Otherwise a keyboard
   * user lands on an invisible "Dismiss notice" checkbox and pressing Space
   * both re-opens the bar and wipes the stored dismissal — every page load,
   * for DISMISS_DAYS.
   *
   * :checked still matches while display is none, so the sibling rule above
   * and the :has() rule below are unaffected.
   */
  .cf-banner-toggle:checked { display: none; }
  ${PUSH_CONTENT ? pushContentCss() : ""}
  @media print {
    .cf-banner, .cf-banner-toggle { display: none !important; }
    body { padding-top: 0 !important; }
  }
</style>
${DISMISS_DAYS > 0 ? DISMISS_SCRIPT : ""}`;

/**
 * One offset variable drives every rule, so dismissing the banner only has to
 * flip that one value rather than restore each override individually.
 *
 * Uses vh rather than dvh deliberately: the app sizes itself with Tailwind's
 * h-screen (100vh), and mixing units would leave a gap on mobile.
 */
function pushContentCss() {
  const shell = APP_ROOT_SELECTOR
    ? `
  body > ${APP_ROOT_SELECTOR},
  body > ${APP_ROOT_SELECTOR} .h-screen {
    height: calc(100vh - var(--cf-banner-offset)) !important;
  }
  body > ${APP_ROOT_SELECTOR} .min-h-screen {
    min-height: calc(100vh - var(--cf-banner-offset)) !important;
  }`
    : "";

  return `
  body {
    --cf-banner-offset: ${BANNER_HEIGHT};
    padding-top: var(--cf-banner-offset) !important;
  }
  body:has(.cf-banner-toggle:checked) { --cf-banner-offset: 0px; }${shell}`;
}

/**
 * djb2. The XOR coerces h back to int32 every iteration, so it stays within
 * ±2^31 and the multiply never approaches the 2^53 limit of exact integer
 * arithmetic — the result is identical across engines and message lengths.
 * Fine for telling one message from another, which is all this is for; not a
 * checksum, and not a security hash.
 */
function hash(value) {
  let h = 5381;
  for (let i = 0; i < value.length; i += 1) {
    h = (h * 33) ^ value.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

/**
 * Escapes markup, and additionally emits every non-ASCII character as a
 * numeric reference so the banner is pure ASCII on the wire.
 *
 * The origin sends `content-type: text/html` with no charset parameter and
 * the document is otherwise all ASCII, so browsers sniff Windows-1252. Raw
 * UTF-8 for an em dash then renders as "a€" — numeric references sidestep
 * the whole question without touching the origin's own encoding.
 *
 * Array.from iterates by code point, so characters outside the BMP (emoji)
 * survive rather than being split into lone surrogates.
 */
function escapeHtml(value) {
  return Array.from(value, (char) => {
    if (char in HTML_ESCAPES) return HTML_ESCAPES[char];
    const code = char.codePointAt(0);
    return code > LAST_ASCII ? `&#${code};` : char;
  }).join("");
}

// ---------------------------------------------------------------------------
// Snippet entrypoint
// ---------------------------------------------------------------------------

const bannerInjector = {
  element(element) {
    element.prepend(MARKUP, { html: true });
  },
};

export default {
  async fetch(request) {
    const navigation = isNavigation(request);

    // A conditional request the origin answers with 304 has no body, so there
    // is nothing to inject into and the browser falls back to its cached copy
    // of the page — which predates this Snippet. The origin's ETag is derived
    // from a file that never changes, so that stale copy would win forever.
    // Dropping the validators forces a full 200 we can actually rewrite.
    const response = await fetch(
      navigation ? withoutConditionalHeaders(request) : request,
    );

    if (!navigation || !isHtml(response)) {
      return response;
    }

    const injected = new HTMLRewriter()
      .on("body", bannerInjector)
      .transform(response);

    return withoutValidators(injected);
  },
};

/**
 * Browsers label top-level navigations as "document".
 *
 * Clients that predate Fetch Metadata — Safari before 16.4, curl, monitoring
 * probes — send no Sec-Fetch-Dest at all. Treating that as a navigation
 * outright meant every subresource such a client fetched had its cache
 * validators stripped (a full bundle re-download per page load), and any
 * text/html fragment the SPA pulled over XHR got a banner spliced into it —
 * exactly what the note at the top of this file promises cannot happen.
 *
 * Accept separates the two cases: browsers ask for text/html when fetching a
 * document and for something narrower - text/css, an image type, or a bare
 * wildcard - when fetching a subresource. A
 * caller sending no Accept at all is passed through untouched rather than
 * assumed to be a navigation, so an unknown client cannot be injected into.
 *
 * The cost is that a bare `curl` no longer sees the banner, because it sends
 * only a wildcard Accept. Pass -H 'Accept: text/html', as the README's verify
 * step now does. ./banner sets Sec-Fetch-Dest explicitly and is unaffected.
 */
function isNavigation(request) {
  const dest = request.headers.get("sec-fetch-dest");
  if (dest !== null) return dest === "document";

  const accept = request.headers.get("accept");
  return accept !== null && accept.toLowerCase().includes("text/html");
}

function isHtml(response) {
  if (!response.ok) return false;
  const contentType = response.headers.get("content-type") || "";
  return contentType.toLowerCase().includes("text/html");
}

function withoutConditionalHeaders(request) {
  const headers = new Headers(request.headers);
  headers.delete("if-none-match");
  headers.delete("if-modified-since");
  return new Request(request, { headers });
}

/**
 * The origin's ETag and Last-Modified describe the un-injected file. Passing
 * them through would let a later conditional request validate against content
 * that no longer matches what we serve.
 */
function withoutValidators(response) {
  const out = new Response(response.body, response);
  out.headers.delete("etag");
  out.headers.delete("last-modified");
  return out;
}
