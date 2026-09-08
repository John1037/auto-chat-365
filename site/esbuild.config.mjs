import { build } from "esbuild";

// Two small, separate entry points -- each page loads only what it needs, and
// neither has to guess which page it's on at runtime.
await build({
  entryPoints: ["src/login.ts", "src/dashboard.ts"],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2020",
  outdir: "../worker/public",
});

console.log("site: built login.js, dashboard.js -> worker/public/");
