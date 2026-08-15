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
 *  - Dismissal is pure CSS (visually-hidden checkbox + sibling selector). No
 *    inline JavaScript, so it survives any script-src Content-Security-Policy
 *    the origin sets.
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

// Exported so preview.mjs can render the exact same banner locally. The
// Snippets runtime only ever calls the default export.
export const MARKUP = `
<input type="checkbox" id="cf-banner-dismiss" class="cf-banner-toggle" aria-label="Dismiss notice">
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
  ${PUSH_CONTENT ? pushContentCss() : ""}
  @media print {
    .cf-banner, .cf-banner-toggle { display: none !important; }
    body { padding-top: 0 !important; }
  }
</style>
`;

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
 * Browsers label top-level navigations as "document". An absent header (curl,
 * older clients) is treated as a navigation so the banner still shows.
 */
function isNavigation(request) {
  const dest = request.headers.get("sec-fetch-dest");
  return dest === null || dest === "document";
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
