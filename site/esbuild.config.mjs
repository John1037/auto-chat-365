import { build } from "esbuild";

// Small, separate entry points -- each page loads only what it needs, and neither
// has to guess which page it's on at runtime. app-shell.ts is shared by pages with
// no other page-specific logic (dashboard/settings/knowledge-base-analysis.html).
await build({
  entryPoints: [
    "src/login.ts",
    "src/app-shell.ts",
    "src/widgets.ts",
    "src/widget-new.ts",
    "src/widget-settings.ts",
    "src/knowledge-base-review.ts",
    "src/knowledge-base-embed.ts",
  ],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2020",
  outdir: "../worker/public",
});

console.log(
  "site: built login.js, app-shell.js, widgets.js, widget-new.js, widget-settings.js, knowledge-base-review.js, knowledge-base-embed.js -> worker/public/",
);
