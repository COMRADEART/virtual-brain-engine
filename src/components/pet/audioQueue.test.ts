import { describe, expect, it, vi } from "vitest";
import { SerialAudioPlayer, type AudioEnv, type AudioLike } from "./audioQueue";

// A controllable mock Audio: play() resolves immediately; we trigger onended
// manually to simulate playback completing.
class MockAudio implements AudioLike {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  played = false;
  paused = false;
  constructor(public readonly url: string, private readonly rejectPlay = false) {}
  play(): Promise<void> {
    this.played = true;
    return this.rejectPlay ? Promise.reject(new Error("autoplay blocked")) : Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  end(): void {
    this.onended?.();
  }
}

function makeEnv(rejectPlay = false) {
  const created: MockAudio[] = [];
  const revoked: string[] = [];
  let n = 0;
  const env: AudioEnv = {
    decodeBase64: (b64) => new Uint8Array([b64.length]),
    createUrl: () => `blob:url-${n++}`,
    revokeUrl: (url) => {
      revoked.push(url);
    },
    createAudio: (url) => {
      const a = new MockAudio(url, rejectPlay);
      created.push(a);
      return a;
    },
  };
  return { env, created, revoked };
}

describe("SerialAudioPlayer", () => {
  it("plays a clip and reports playing until it ends", async () => {
    const { env, created } = makeEnv();
    const p = new SerialAudioPlayer(env);
    await p.play("aGVsbG8=");
    expect(created).toHaveLength(1);
    expect(created[0].played).toBe(true);
    expect(p.playing).toBe(true);
    created[0].end();
    expect(p.playing).toBe(false);
  });

  it("never overlaps: a second clip stops + revokes the first (no garble)", async () => {
    const { env, created, revoked } = makeEnv();
    const p = new SerialAudioPlayer(env);
    await p.play("Y2xpcEE="); // clip A
    await p.play("Y2xpcEI="); // clip B arrives before A finished
    expect(created).toHaveLength(2);
    expect(created[0].paused).toBe(true); // A was stopped
    expect(revoked).toContain(created[0].url); // A's url freed (no leak)
    expect(p.playing).toBe(true); // B is the active clip
  });

  it("stop() gives barge-in: pauses + revokes the current clip", async () => {
    const { env, created, revoked } = makeEnv();
    const p = new SerialAudioPlayer(env);
    await p.play("YXVkaW8=");
    p.stop();
    expect(created[0].paused).toBe(true);
    expect(revoked).toContain(created[0].url);
    expect(p.playing).toBe(false);
  });

  it("holds the object URL until playback ends, then revokes exactly once", async () => {
    const { env, created, revoked } = makeEnv();
    const p = new SerialAudioPlayer(env);
    await p.play("YXVkaW8=");
    expect(revoked).not.toContain(created[0].url); // not revoked mid-play
    created[0].end();
    expect(revoked).toEqual([created[0].url]); // revoked once on end
  });

  it("cleans up when play() is rejected (autoplay blocked)", async () => {
    const { env, created, revoked } = makeEnv(true);
    const p = new SerialAudioPlayer(env);
    await p.play("YXVkaW8=");
    expect(created[0].played).toBe(true);
    expect(revoked).toContain(created[0].url); // released, no leak
    expect(p.playing).toBe(false);
  });

  it("ignores empty input and never throws on decode failure", async () => {
    const { env } = makeEnv();
    const p = new SerialAudioPlayer(env);
    await expect(p.play("")).resolves.toBeUndefined();
    const throwingEnv: AudioEnv = {
      ...env,
      decodeBase64: vi.fn(() => {
        throw new Error("bad base64");
      }),
    };
    const p2 = new SerialAudioPlayer(throwingEnv);
    await expect(p2.play("zzz")).resolves.toBeUndefined();
    expect(p2.playing).toBe(false);
  });
});
