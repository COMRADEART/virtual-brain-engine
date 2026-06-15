// "Read any file into the brain" selfcheck. HERMETIC: throwaway DB via
// BRAIN_DB_PATH, NO worker, NO network, NO embeddings (uploads persist without a
// vector). Tests the pure extractor across formats AND the governed ingest path
// with injected (caption/embed) deps.
//
// Run: npm --prefix server run fileingest:selfcheck
//
// Asserts:
//   Extract — text/code, HTML (markup stripped), a hand-built uncompressed PDF,
//             a hand-built STORED-zip .docx, and an opaque binary (→ nothing).
//   Ingest  — a text file lands as retrievable memory; a re-upload is deduped.
//   Image   — with a caption stub it is described + stored + retrievable; with a
//             worker error or NO worker it is NOT stored and the note is honest.
//   Source  — "file" is a registered ingest source.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-filecheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const { openDb } = await import("../src/db/sqlite.js");
const { extractTextFromFile } = await import("../src/settings/fileExtract.js");
const { ingestUploadedFile } = await import("../src/settings/fileIngest.js");
const { keywordSearch, countMemoryPoints } = await import("../src/db/repositories/memory.js");
const { INGEST_SOURCES } = await import("../../shared/ingest.js");

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// Build a ZIP with a single STORED (uncompressed) entry — enough to exercise the
// central-directory reader without pulling in a deflate dependency.
function buildStoredZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const localOffsets: number[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8); // method 0 = stored
    lh.writeUInt32LE(0, 14); // crc (reader ignores it)
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    localOffsets.push(offset);
    const local = Buffer.concat([lh, nameBuf, e.data]);
    locals.push(local);
    offset += local.length;
  }
  const cdStart = offset;
  entries.forEach((e, i) => {
    const nameBuf = Buffer.from(e.name, "utf8");
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 10); // method stored
    ch.writeUInt32LE(0, 16); // crc
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(localOffsets[i], 42);
    centrals.push(Buffer.concat([ch, nameBuf]));
    offset += 46 + nameBuf.length;
  });
  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

openDb();

// --- Extractor: text / code -------------------------------------------------
{
  const r = extractTextFromFile("notes.txt", "text/plain", Buffer.from("the brain uses sqlite and three.js together"));
  check("text file → kind text", r.kind === "text");
  check("text content preserved", r.text.includes("sqlite") && r.text.includes("three.js"));

  const code = extractTextFromFile("a.py", "", Buffer.from("def hello():\n    return 'world'"));
  check("code by extension → kind text", code.kind === "text" && code.text.includes("def hello"));
}

// --- Extractor: HTML markup -------------------------------------------------
{
  const html = "<title>Doc</title><body><script>var x=1;</script><p>hello <b>world</b> brain</p></body>";
  const r = extractTextFromFile("page.html", "text/html", Buffer.from(html));
  check("html → kind html", r.kind === "html");
  check("html text extracted, tags stripped", r.text.includes("hello world brain") && !r.text.includes("<b>"));
  check("html drops <script>", !r.text.includes("var x=1"));
}

// --- Extractor: PDF (uncompressed content stream) ---------------------------
{
  const pdf = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Length 48 >>\nstream\n" +
      "BT /F1 12 Tf 72 720 Td (Hello PDF Extract sqlite) Tj ET\n" +
      "endstream\nendobj\ntrailer\n<<>>\n%%EOF",
    "latin1",
  );
  const r = extractTextFromFile("doc.pdf", "application/pdf", pdf);
  check("pdf → kind pdf", r.kind === "pdf");
  check("pdf text operators extracted", r.text.includes("Hello PDF Extract sqlite"), JSON.stringify(r.text.slice(0, 80)));
}

// --- Extractor: Office (.docx via stored zip) -------------------------------
{
  const xml =
    "<w:document><w:body><w:p><w:t>Docx sqlite content here</w:t></w:p>" +
    "<w:p><w:t>second paragraph</w:t></w:p></w:body></w:document>";
  const zip = buildStoredZip([{ name: "word/document.xml", data: Buffer.from(xml, "utf8") }]);
  const r = extractTextFromFile("report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", zip);
  check("docx → kind office", r.kind === "office", `kind=${r.kind}`);
  check("docx text extracted from XML", r.text.includes("Docx sqlite content here") && r.text.includes("second paragraph"));
}

// --- Extractor: opaque binary → nothing -------------------------------------
{
  const bin = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 0xc8, 0xc9, 0xca, 0xcb]);
  const r = extractTextFromFile("blob.bin", "application/octet-stream", bin);
  check("opaque binary → kind binary, no text", r.kind === "binary" && r.text === "");
}

// --- Ingest: a text file lands as retrievable memory ------------------------
{
  const before = countMemoryPoints();
  const r = await ingestUploadedFile({
    filename: "upload.md",
    mimeType: "text/markdown",
    bytes: Buffer.from("# Project\nThe STAR brain ingests uploaded files into governed memory."),
  });
  check("text upload is ingested", r.ok && r.ingest.ingested >= 1, `ingested=${r.ingest.ingested}`);
  check("uploaded text is retrievable", keywordSearch("governed memory", 5).length >= 1);
  check("upload increased memory count", countMemoryPoints() > before);

  const dup = await ingestUploadedFile({
    filename: "upload.md",
    mimeType: "text/markdown",
    bytes: Buffer.from("# Project\nThe STAR brain ingests uploaded files into governed memory."),
  });
  check("re-upload is deduped", dup.ingest.ingested === 0 && dup.ingest.deduped >= 1);
}

// --- Ingest: image via caption stub -----------------------------------------
{
  const img = { filename: "photo.png", mimeType: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) };
  const r = await ingestUploadedFile(img, {
    caption: async () => ({ ok: true, caption: "a red bicycle leaning on a wall" }),
  });
  check("image with caption is ingested", r.ok && r.kind === "image" && r.ingest.ingested === 1);
  check("image caption is retrievable", keywordSearch("red bicycle", 5).length >= 1);

  const err = await ingestUploadedFile(img, { caption: async () => ({ ok: false, error: "worker offline" }) });
  check("image caption error → not stored, honest note", err.ingest.ingested === 0 && err.ok === false && /offline|could not/i.test(err.note));

  const none = await ingestUploadedFile({ filename: "x.jpg", mimeType: "image/jpeg", bytes: Buffer.from([1, 2, 3, 4]) }, {});
  check("image with no worker → not stored, explains", none.ingest.ingested === 0 && /worker/i.test(none.note));
}

// --- Ingest: opaque binary → nothing stored ---------------------------------
{
  const r = await ingestUploadedFile({
    filename: "blob.bin",
    mimeType: "application/octet-stream",
    bytes: Buffer.from([0, 1, 2, 3, 0xff, 0xfe, 0xfd]),
  });
  check("opaque binary upload stores nothing", r.ingest.ingested === 0 && r.kind === "binary");
}

// --- Source registration ----------------------------------------------------
check("'file' is a registered ingest source", INGEST_SOURCES.some((s) => s.id === "file"));

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
