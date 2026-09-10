import { build } from "esbuild";

// IIFE, not ESM -- this runs on arbitrary third-party pages via a bare <script> tag,
// not as a module import, and needs to be self-contained with no global namespace
// pollution beyond what it deliberately exposes.
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2019",
  outfile: "../worker/public/widget.js",
});

console.log("widget: built widget.js -> worker/public/");
