// Slice file text into ~800-char windows with 120-char overlap. For .ts/.tsx/.js/.jsx
// the chunker additionally cuts on common top-level declaration lines so chunks
// roughly align with definitions.

const WINDOW = 800;
const OVERLAP = 120;
const CODE_BOUNDARY = /^(export |function |class |const |interface |type |async )/m;

export interface Chunk {
  index: number;
  content: string;
}

function looksLikeCode(ext: string): boolean {
  return ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx";
}

function splitOnBoundaries(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (current.length > 0 && CODE_BOUNDARY.test(line)) {
      blocks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    blocks.push(current.join("\n"));
  }
  return blocks;
}

function windowOver(text: string): string[] {
  if (text.length <= WINDOW) {
    return [text];
  }
  const out: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const end = Math.min(text.length, cursor + WINDOW);
    out.push(text.slice(cursor, end));
    if (end >= text.length) {
      break;
    }
    cursor = end - OVERLAP;
  }
  return out;
}

export function chunkFile(content: string, ext: string): Chunk[] {
  if (content.length === 0) {
    return [];
  }
  const blocks = looksLikeCode(ext) ? splitOnBoundaries(content) : [content];
  const chunks: Chunk[] = [];
  let index = 0;
  for (const block of blocks) {
    for (const slice of windowOver(block)) {
      const trimmed = slice.trim();
      if (trimmed.length < 40) {
        continue;
      }
      chunks.push({ index, content: slice });
      index += 1;
    }
  }
  return chunks;
}
