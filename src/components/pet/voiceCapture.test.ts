import { describe, expect, it } from "vitest";
import {
  RECORDER_MIME_CANDIDATES,
  pickRecorderMime,
  blobToBase64,
  isRecordingSupported,
  type BlobLike,
} from "./voiceCapture";

function fakeBlob(bytes: number[]): BlobLike {
  const u8 = new Uint8Array(bytes);
  return { size: u8.length, arrayBuffer: async () => u8.buffer };
}

describe("voiceCapture", () => {
  it("picks the first supported recorder MIME", () => {
    const ctor = { isTypeSupported: (t: string) => t === RECORDER_MIME_CANDIDATES[1] };
    expect(pickRecorderMime(ctor)).toBe(RECORDER_MIME_CANDIDATES[1]);
  });

  it("prefers opus-webm when everything is supported", () => {
    const ctor = { isTypeSupported: () => true };
    expect(pickRecorderMime(ctor)).toBe(RECORDER_MIME_CANDIDATES[0]);
  });

  it("returns '' (browser default) when nothing is supported or ctor missing", () => {
    expect(pickRecorderMime({ isTypeSupported: () => false })).toBe("");
    expect(pickRecorderMime(undefined)).toBe("");
    expect(pickRecorderMime({})).toBe("");
  });

  it("base64-encodes a blob without the data: prefix", async () => {
    // "hi" → bytes [104, 105] → btoa("hi") === "aGk="
    expect(await blobToBase64(fakeBlob([104, 105]))).toBe("aGk=");
  });

  it("base64 round-trips a larger buffer (chunked path)", async () => {
    const bytes = Array.from({ length: 100_000 }, (_, i) => i % 256);
    const b64 = await blobToBase64(fakeBlob(bytes));
    const decoded = atob(b64);
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.charCodeAt(0)).toBe(0);
    expect(decoded.charCodeAt(255)).toBe(255);
  });

  it("isRecordingSupported returns a boolean (false in jsdom — no MediaRecorder)", () => {
    expect(typeof isRecordingSupported()).toBe("boolean");
  });
});
