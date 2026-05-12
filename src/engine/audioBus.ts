// Ambient drone bus. A barely-audible low pad whose loudness tracks total brain
// activity, off by default. Built on Web Audio with two slightly-detuned sine
// oscillators through a low-pass filter into a master gain. We keep the gain
// well under 0.1 so the audio is presence, not noise.

export interface AmbientBus {
  setEnabled(on: boolean): void;
  setActivity(level: number): void;
  dispose(): void;
}

// Peak gain when activity is 1.0. Kept very low so the drone is felt more than
// heard — louder would compete with the user's other tabs.
const PEAK_GAIN = 0.05;

export function createAmbientBus(): AmbientBus {
  let ctx: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  let osc1: OscillatorNode | null = null;
  let osc2: OscillatorNode | null = null;
  let filter: BiquadFilterNode | null = null;
  let enabled = false;
  let activity = 0;
  let disposed = false;

  const ensureContext = (): boolean => {
    if (disposed) {
      return false;
    }
    if (ctx) {
      return true;
    }
    const Ctor = (window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext) as typeof AudioContext | undefined;
    if (!Ctor) {
      return false;
    }
    ctx = new Ctor();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0;

    filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 620;
    filter.Q.value = 0.7;

    osc1 = ctx.createOscillator();
    osc1.type = "sine";
    osc1.frequency.value = 55;
    osc1.detune.value = -4;

    osc2 = ctx.createOscillator();
    osc2.type = "sine";
    osc2.frequency.value = 110;
    osc2.detune.value = 4;

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(masterGain);
    masterGain.connect(ctx.destination);

    osc1.start();
    osc2.start();
    return true;
  };

  const targetGain = (): number => PEAK_GAIN * Math.max(0, Math.min(1, activity));

  const rampGainTo = (value: number, durationSeconds: number): void => {
    if (!ctx || !masterGain) {
      return;
    }
    const now = ctx.currentTime;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setValueAtTime(masterGain.gain.value, now);
    masterGain.gain.linearRampToValueAtTime(value, now + durationSeconds);
  };

  return {
    setEnabled(on) {
      if (disposed || enabled === on) {
        return;
      }
      enabled = on;
      if (on) {
        if (!ensureContext() || !ctx) {
          return;
        }
        if (ctx.state === "suspended") {
          void ctx.resume();
        }
        rampGainTo(targetGain(), 0.25);
      } else if (ctx) {
        rampGainTo(0, 0.2);
        // Suspend the context after the ramp finishes so we stop burning CPU
        // entirely while muted.
        window.setTimeout(() => {
          if (!enabled && ctx) {
            void ctx.suspend();
          }
        }, 260);
      }
    },
    setActivity(level) {
      activity = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
      if (!enabled || !ctx || !masterGain) {
        return;
      }
      rampGainTo(targetGain(), 0.15);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      enabled = false;
      if (!ctx) {
        return;
      }
      try {
        osc1?.stop();
        osc2?.stop();
      } catch {
        // ignore
      }
      try {
        void ctx.close();
      } catch {
        // ignore
      }
      ctx = null;
      masterGain = null;
      osc1 = null;
      osc2 = null;
      filter = null;
    },
  };
}
