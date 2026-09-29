"use client";

import { useSyncExternalStore } from "react";

/**
 * Game sounds, synthesized with WebAudio (no audio files). Off by default; the choice is kept in
 * `localStorage` when the browser allows it. Decoration only: nothing depends on hearing them.
 */

export type SoundName = "tick" | "takeoff" | "milestone" | "cashout" | "settled" | "crash";

const STORAGE_KEY = "crashit:sound";
let enabled: boolean | null = null;
let context: AudioContext | null = null;
const listeners = new Set<() => void>();

function readPreference(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function soundEnabled(): boolean {
  if (enabled === null) enabled = readPreference();
  return enabled;
}

/** Call from a user gesture: browsers only start audio after one. */
export function setSoundEnabled(on: boolean): void {
  enabled = on;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
  if (on) void audio()?.resume().catch(() => undefined);
  else stopRise();
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSoundEnabled(): boolean {
  return useSyncExternalStore(subscribe, soundEnabled, () => false);
}

function audio(): AudioContext | null {
  if (context) return context;
  const Ctor = typeof window === "undefined" ? undefined : (window.AudioContext ?? undefined);
  if (!Ctor) return null;
  try {
    context = new Ctor();
  } catch {
    context = null;
  }
  return context;
}

interface Tone {
  type: OscillatorType;
  from: number;
  to: number;
  start: number;
  duration: number;
  gain: number;
}

const SOUNDS: Record<SoundName, Tone[]> = {
  tick: [{ type: "square", from: 880, to: 880, start: 0, duration: 0.05, gain: 0.04 }],
  takeoff: [
    { type: "sawtooth", from: 180, to: 720, start: 0, duration: 0.45, gain: 0.05 },
    { type: "sine", from: 360, to: 1_440, start: 0.05, duration: 0.4, gain: 0.04 },
  ],
  milestone: [
    { type: "triangle", from: 990, to: 990, start: 0, duration: 0.07, gain: 0.05 },
    { type: "triangle", from: 1_480, to: 1_480, start: 0.06, duration: 0.12, gain: 0.05 },
  ],
  cashout: [
    { type: "triangle", from: 660, to: 660, start: 0, duration: 0.09, gain: 0.08 },
    { type: "triangle", from: 880, to: 880, start: 0.09, duration: 0.09, gain: 0.08 },
    { type: "triangle", from: 1_320, to: 1_320, start: 0.18, duration: 0.2, gain: 0.08 },
  ],
  settled: [
    { type: "sine", from: 1_760, to: 1_760, start: 0, duration: 0.08, gain: 0.05 },
    { type: "sine", from: 2_350, to: 2_350, start: 0.07, duration: 0.18, gain: 0.04 },
  ],
  crash: [
    { type: "sawtooth", from: 420, to: 60, start: 0, duration: 0.55, gain: 0.08 },
    { type: "square", from: 90, to: 40, start: 0.02, duration: 0.4, gain: 0.05 },
  ],
};

export function playSound(name: SoundName): void {
  if (!soundEnabled()) return;
  const ctx = audio();
  if (!ctx || ctx.state !== "running") return;
  const now = ctx.currentTime;
  for (const tone of SOUNDS[name]) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = tone.type;
    oscillator.frequency.setValueAtTime(tone.from, now + tone.start);
    oscillator.frequency.exponentialRampToValueAtTime(tone.to, now + tone.start + tone.duration);
    gain.gain.setValueAtTime(tone.gain, now + tone.start);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.start + tone.duration);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(now + tone.start);
    oscillator.stop(now + tone.start + tone.duration + 0.02);
  }
}

/** Pitch of the rise tone: 150 Hz at 1x, about 700 Hz at 100x. */
export function riseFrequency(multiplier: number): number {
  return 150 * Math.max(1, multiplier) ** (1 / 3);
}

let rise: { oscillator: OscillatorNode; gain: GainNode } | null = null;

/** Starts the continuous tone that follows the running multiplier (no-op if sound is off). */
export function startRise(): void {
  if (rise || !soundEnabled()) return;
  const ctx = audio();
  if (!ctx || ctx.state !== "running") return;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(riseFrequency(1), ctx.currentTime);
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.018, ctx.currentTime + 0.3);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start();
  rise = { oscillator, gain };
}

/** Glides the rise tone to the multiplier now shown. */
export function setRise(multiplier: number): void {
  if (!rise || !context) return;
  rise.oscillator.frequency.setTargetAtTime(riseFrequency(multiplier), context.currentTime, 0.05);
}

export function stopRise(): void {
  if (!rise || !context) return;
  const { oscillator, gain } = rise;
  rise = null;
  const now = context.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setTargetAtTime(0.0001, now, 0.03);
  oscillator.stop(now + 0.2);
}
