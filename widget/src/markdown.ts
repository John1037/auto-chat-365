import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

// Anchors always open in a new tab rather than navigating the host page out from
// under the visitor, and never carry an opener reference back to it.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const ALLOWED_TAGS = [
  "p", "strong", "em", "code", "pre", "ul", "ol", "li", "a", "br",
  "blockquote", "h1", "h2", "h3", "h4", "table", "thead", "tbody", "tr", "th", "td", "hr", "del",
];

// Assistant replies are LLM output rendered as markdown (so **bold**, lists, and
// inline code display formatted instead of showing literal symbols) -- but that text
// can echo tenant-uploaded document content, or be shaped by a prompt-injection
// attempt in a user message, so the parsed HTML is always sanitized before it's ever
// assigned via innerHTML. Never skip DOMPurify here, even for "obviously safe" text.
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR: ["href"] });
}
