/**
 * Renders the banner over a stand-in page so the styling can be eyeballed
 * without deploying. Pulls MARKUP straight from snippet.js so the preview
 * cannot drift from what actually ships.
 *
 *   npm run preview && open test/preview.html
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { MARKUP } from "../snippet.js";

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>cf-banner preview</title>
  <style>
    /* The host app's real tokens, sampled from the live page, so the preview
       resolves the same custom properties production will. */
    :root {
      --caution: 38 92% 50%;
      --caution-hover: 32 95% 44%;
      --caution-background: 32 98% 83%;
      --caution-foreground: 15 75% 28%;
      --destructive: 0 74% 42%;
      --destructive-foreground: 0 86% 97%;
      --destructive-active: 0 63% 31%;
      --foreground: 240 6% 10%;
      --ring: 240 6% 10%;
    }
    body { margin: 0; background: #fafafa; font: 16px/1.5 Figtree, HelveticaNeue, Arial, sans-serif; }
    .mock-nav { height: 56px; background: #1f2937; color: #fff; display: flex; align-items: center; padding: 0 24px; }
    .mock-body { padding: 32px 24px; color: #374151; }
  </style>
</head>
<body>
${MARKUP}
  <div class="mock-nav">Stand-in app header</div>
  <div class="mock-body">
    <h1>Preview</h1>
    <p>The banner above is the exact markup snippet.js injects.</p>
  </div>
</body>
</html>
`;

const out = fileURLToPath(new URL("./preview.html", import.meta.url));
writeFileSync(out, page);
console.log(`wrote ${out}`);
