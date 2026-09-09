import { build } from "esbuild";

// Small, separate entry points -- each page loads only what it needs, and neither
// has to guess which page it's on at runtime. app-shell.ts is shared by every
// authenticated page (dashboard/knowledge-base/settings.html).
await build({
  entryPoints: ["src/login.ts", "src/app-shell.ts"],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2020",
  outdir: "../worker/public",
});

console.log("site: built login.js, app-shell.js -> worker/public/");
