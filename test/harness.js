/**
 * Local test harness: runs snippet.js against the real origin under workerd
 * (the same runtime Snippets use), so the HTMLRewriter path is genuinely
 * exercised rather than simulated.
 *
 *   npx wrangler dev --config test/wrangler.jsonc --port 8787
 *   curl -s localhost:8787 | grep cf-banner
 */

import snippet from "../snippet.js";

const ORIGIN = "https://airiaazure.davidpacold.com";

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    const target = new URL(incoming.pathname + incoming.search, ORIGIN);

    const proxied = new Request(target, request);
    proxied.headers.set("host", target.host);

    return snippet.fetch(proxied);
  },
};
