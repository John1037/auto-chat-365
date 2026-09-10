const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 150;

// Simple fixed-size character chunking with overlap -- a reasonable default for
// prose-style knowledge-base documents without needing a real tokenizer on the
// Workers runtime. Overlap keeps a fact from being silently split exactly at a
// chunk boundary and lost from both halves' context.
export function chunkText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < trimmed.length) {
    const end = Math.min(start + CHUNK_SIZE, trimmed.length);
    chunks.push(trimmed.slice(start, end));
    if (end === trimmed.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}
