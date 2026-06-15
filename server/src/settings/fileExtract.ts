// Dependency-free "read any file" text extraction. PURE (no DB, no network) so
// it is trivially testable. Given a file's bytes + name + mime, it returns the
// best readable text it can pull out:
//
//   text / code / markup  -> UTF-8 decode (HTML/SVG -> readable text via htmlToText)
//   pdf                   -> best-effort: inflate FlateDecode streams (Node zlib),
//                            pull text out of content-stream string operators
//   office (docx/pptx/xlsx) -> minimal ZIP reader -> inflate the text parts -> strip XML
//   image                 -> NOT handled here (needs the perception worker); the
//                            caller routes images to caption(). Returns kind:"image".
//   anything else         -> printable-run salvage; too little -> "" (caller stubs)
//
// Best-effort by design: encrypted/scanned PDFs, exotic fonts, and binary blobs
// yield little or nothing, and that is reported honestly via `note` rather than
// faked. Everything is bounded + failure-isolated; a malformed file never throws.

import { inflateSync, inflateRawSync } from "node:zlib";
import { htmlToText } from "../ingest/webFetch.js";

export type FileKind = "text" | "html" | "pdf" | "office" | "image" | "binary";

export interface FileExtractResult {
  kind: FileKind;
  text: string; // "" when nothing usable could be extracted
  note: string;
  truncated: boolean;
}

const MAX_TEXT_CHARS = 200_000;

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "ico", "avif", "heic"]);
const OFFICE_EXTS = new Set(["docx", "pptx", "xlsx"]);
const HTML_EXTS = new Set(["html", "htm", "xhtml"]);
// Treated as plain UTF-8 text. SVG is XML, so it goes through the HTML branch.
const TEXT_EXTS = new Set([
  "txt", "text", "md", "markdown", "rst", "log", "csv", "tsv", "json", "json5", "jsonl",
  "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "env",
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "css", "scss", "sass", "less",
  "py", "rb", "go", "rs", "java", "kt", "kts", "c", "h", "cpp", "cc", "hpp", "cs",
  "php", "swift", "scala", "sh", "bash", "zsh", "ps1", "bat", "sql", "graphql", "gql",
  "vue", "svelte", "astro", "lua", "pl", "r", "dart", "ex", "exs", "clj", "hs", "elm",
  "tex", "bib", "srt", "vtt", "gitignore", "dockerfile", "makefile",
]);

function extOf(filename: string): string {
  const base = filename.toLowerCase().split(/[\\/]/).pop() ?? "";
  // Files like "Dockerfile" / "Makefile" have no dot but a meaningful name.
  if (!base.includes(".")) return base;
  return base.slice(base.lastIndexOf(".") + 1);
}

function detectKind(filename: string, mimeType: string): FileKind {
  const mime = (mimeType || "").toLowerCase();
  const ext = extOf(filename);

  if (mime.startsWith("image/") || IMAGE_EXTS.has(ext)) {
    // SVG is text even though its mime is image/svg+xml.
    if (ext === "svg" || mime.includes("svg")) return "html";
    return "image";
  }
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (OFFICE_EXTS.has(ext) || mime.includes("officedocument") || mime.includes("opendocument")) {
    return "office";
  }
  if (mime.includes("html") || mime.includes("xml") || HTML_EXTS.has(ext) || ext === "svg") return "html";
  if (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("javascript") ||
    mime.includes("yaml") ||
    mime.includes("csv") ||
    TEXT_EXTS.has(ext)
  ) {
    return "text";
  }
  return "binary";
}

function clamp(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
}

// --- PDF --------------------------------------------------------------------

// Decode a PDF literal string's escape sequences (\n \t \( \) \\ and octal \ddd).
function decodePdfString(s: string): string {
  return s.replace(/\\(\n|[nrtbf()\\]|[0-7]{1,3})/g, (_m, e: string) => {
    if (e === "\n") return ""; // line continuation
    if (e === "n") return "\n";
    if (e === "r") return "\r";
    if (e === "t") return "\t";
    if (e === "b") return "";
    if (e === "f") return "";
    if (e === "(") return "(";
    if (e === ")") return ")";
    if (e === "\\") return "\\";
    return String.fromCharCode(parseInt(e, 8) & 0xff);
  });
}

// Pull text from ONE decoded content stream. Only trusted when the stream
// actually carries text-showing operators (BT/ET or Tj/TJ) -- that filters out
// inflated font/image/metadata streams that would otherwise emit garbage.
function extractPdfTextOps(content: string): string {
  if (!/\bBT\b/.test(content) && !/\bTj\b/.test(content) && !/\bTJ\b/.test(content)) {
    return "";
  }
  const parts: string[] = [];
  const re = /\((?:\\[\s\S]|[^()\\])*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const decoded = decodePdfString(m[0].slice(1, -1));
    if (decoded) parts.push(decoded);
  }
  return parts.join(" ").replace(/[ \t]{2,}/g, " ").trim();
}

function extractPdfText(buf: Buffer): string {
  // latin1 keeps byte offsets 1:1 so indexOf positions line up with subarray.
  const s = buf.toString("latin1");
  const out: string[] = [];
  let total = 0;
  const streamRe = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(s)) && total < MAX_TEXT_CHARS) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) continue;
    const raw = buf.subarray(start, end);
    let content: string;
    try {
      content = inflateSync(raw).toString("latin1");
    } catch {
      try {
        content = inflateRawSync(raw).toString("latin1");
      } catch {
        content = raw.toString("latin1"); // uncompressed content stream
      }
    }
    let extracted: string;
    try {
      extracted = extractPdfTextOps(content);
    } catch {
      extracted = "";
    }
    if (extracted) {
      out.push(extracted);
      total += extracted.length;
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// --- Office (OOXML zip) -----------------------------------------------------

// Minimal ZIP reader: walk the central directory, return the inflated bytes of
// every entry whose name matches. Handles deflate (method 8) and stored
// (method 0). No dependency -- Node's zlib does the inflate.
function readZipEntries(buf: Buffer, match: (name: string) => boolean): Buffer[] {
  const results: Buffer[] = [];
  const EOCD_SIG = 0x06054b50;
  const CDH_SIG = 0x02014b50;
  const LFH_SIG = 0x04034b50;

  // Find End-Of-Central-Directory by scanning backwards (it has a variable-length
  // trailing comment, so it is not at a fixed offset).
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return results;

  let count: number;
  let cdOffset: number;
  try {
    count = buf.readUInt16LE(eocd + 10);
    cdOffset = buf.readUInt32LE(eocd + 16);
  } catch {
    return results;
  }

  let off = cdOffset;
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CDH_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lhOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);

    if (match(name) && lhOff + 30 <= buf.length && buf.readUInt32LE(lhOff) === LFH_SIG) {
      // The local header's name/extra lengths can differ from the central dir's.
      const lhNameLen = buf.readUInt16LE(lhOff + 26);
      const lhExtraLen = buf.readUInt16LE(lhOff + 28);
      const dataStart = lhOff + 30 + lhNameLen + lhExtraLen;
      const comp = buf.subarray(dataStart, dataStart + compSize);
      try {
        results.push(method === 8 ? inflateRawSync(comp) : Buffer.from(comp));
      } catch {
        // skip an unreadable entry
      }
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return results;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// OOXML text lives in <w:t>/<a:t>/<t> nodes; paragraph/row boundaries become
// newlines so structure survives for the chunker.
function ooxmlToText(xml: string): string {
  return xml
    .replace(/<\/(?:w:p|a:p|w:tr|a:tr|text:p)>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|apos);/g, (_m, e: string) => XML_ENTITIES[e] ?? _m)
    .replace(/&#(\d+);/g, (_m, d: string) => {
      const code = Number(d);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : _m;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractOfficeText(buf: Buffer, ext: string): string {
  let match: (name: string) => boolean;
  if (ext === "pptx") {
    match = (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n);
  } else if (ext === "xlsx") {
    match = (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n);
  } else if (ext === "odt" || ext === "odp" || ext === "ods") {
    match = (n) => n === "content.xml";
  } else {
    // docx (default)
    match = (n) => n === "word/document.xml" || /^word\/(?:header|footer)\d+\.xml$/.test(n);
  }
  const entries = readZipEntries(buf, match);
  const text = entries
    .map((e) => ooxmlToText(e.toString("utf8")))
    .filter((t) => t.length > 0)
    .join("\n\n")
    .trim();
  return text.slice(0, MAX_TEXT_CHARS);
}

// --- Binary salvage ---------------------------------------------------------

// Pull runs of printable text out of arbitrary bytes (the `strings` heuristic).
// Catches readable text embedded in otherwise-binary formats; yields nothing for
// truly opaque blobs, which the caller reports honestly.
function printableSalvage(buf: Buffer): string {
  const runs: string[] = [];
  let cur = "";
  const limit = Math.min(buf.length, 8 * 1024 * 1024);
  for (let i = 0; i < limit; i++) {
    const b = buf[i];
    const printable = (b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d;
    if (printable) {
      cur += String.fromCharCode(b);
    } else {
      if (cur.length >= 4) runs.push(cur);
      cur = "";
    }
    if (runs.length > 50_000) break;
  }
  if (cur.length >= 4) runs.push(cur);
  return runs.join(" ").replace(/\s{2,}/g, " ").trim();
}

// --- Entry point ------------------------------------------------------------

export function extractTextFromFile(filename: string, mimeType: string, bytes: Buffer): FileExtractResult {
  const kind = detectKind(filename, mimeType);

  if (kind === "image") {
    return { kind, text: "", note: "image — will be described by the perception worker", truncated: false };
  }

  try {
    if (kind === "text") {
      const c = clamp(bytes.toString("utf8").trim());
      return { kind, text: c.text, note: c.text ? "read as text" : "no readable text", truncated: c.truncated };
    }
    if (kind === "html") {
      const { text } = htmlToText(bytes.toString("utf8"));
      const c = clamp(text.trim());
      return {
        kind,
        text: c.text,
        note: c.text ? "extracted readable text from markup" : "no readable text",
        truncated: c.truncated,
      };
    }
    if (kind === "pdf") {
      const c = clamp(extractPdfText(bytes));
      if (c.text.length < 16) {
        return { kind, text: "", note: "PDF text could not be extracted (likely scanned or encrypted)", truncated: false };
      }
      return { kind, text: c.text, note: "extracted text from PDF (best-effort)", truncated: c.truncated };
    }
    if (kind === "office") {
      const c = clamp(extractOfficeText(bytes, extOf(filename)));
      if (c.text.length < 4) {
        return { kind, text: "", note: "no readable text found in the document", truncated: false };
      }
      return { kind, text: c.text, note: "extracted text from Office document", truncated: c.truncated };
    }
    // binary
    const salvage = printableSalvage(bytes);
    if (salvage.length >= 200) {
      const c = clamp(salvage);
      return { kind: "binary", text: c.text, note: "salvaged readable text from a binary file", truncated: c.truncated };
    }
    return { kind: "binary", text: "", note: "no readable text could be extracted from this file", truncated: false };
  } catch {
    return { kind, text: "", note: "extraction failed", truncated: false };
  }
}
