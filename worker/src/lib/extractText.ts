import { unzipSync, strFromU8 } from "fflate";

const XML_ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&amp;": "&",
};

function unescapeXml(text: string): string {
  return text.replace(/&(lt|gt|quot|apos|amp);/g, (entity) => XML_ENTITIES[entity]);
}

// .docx is a zip archive; the document's text lives in word/document.xml as a
// sequence of <w:p> paragraphs containing <w:t> text runs. A run-level regex is
// enough to pull the text back out without a full XML parser -- runs within one
// paragraph are joined directly (Word splits a run wherever formatting changes,
// often mid-word), paragraphs are joined with blank lines.
function extractDocxText(bytes: Uint8Array): string {
  const files = unzipSync(bytes);
  const xmlBytes = files["word/document.xml"];
  if (!xmlBytes) {
    throw new Error("not a valid .docx file");
  }
  const xml = strFromU8(xmlBytes);

  return xml
    .split(/<\/w:p>/)
    .map((paragraph) =>
      [...paragraph.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
        .map((match) => unescapeXml(match[1]))
        .join(""),
    )
    .filter((line) => line.trim())
    .join("\n\n");
}

export async function extractText(filename: string, bytes: ArrayBuffer): Promise<string> {
  const extension = filename.toLowerCase().split(".").pop();
  if (extension === "txt" || extension === "md") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  if (extension === "docx") {
    return extractDocxText(new Uint8Array(bytes));
  }
  throw new Error(`unsupported file type: .${extension ?? ""}`);
}
