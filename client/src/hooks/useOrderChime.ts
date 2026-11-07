/**
 * Kitchen Display: a chime when a new order arrives. The sound is made in the browser (no audio
 * file). Browsers only allow sound after the person has touched the page once, so `blocked` is
 * true until then and the page asks for a tap.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'jaiva:kitchen-sound';

function readSetting(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeSetting(on: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // Private window / blocked storage: the setting lasts until the page is closed.
  }
}

/** Two rising tones, played twice: loud enough to hear over a kitchen. */
function playChime(ctx: AudioContext) {
  const start = ctx.currentTime + 0.02;
  const notes = [880, 1320, 880, 1320];
  notes.forEach((freq, i) => {
    const at = start + i * 0.18 + (i >= 2 ? 0.25 : 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.6, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.4);
  });
}

/**
 * Plays the chime when an id shows up in `newIds` that was not there before. The ids present on
 * the first load never chime (they were already waiting when the screen opened).
 */
export function useOrderChime(newIds: string[] | undefined) {
  const [enabled, setEnabled] = useState(readSetting);
  const [blocked, setBlocked] = useState(true);
  const ctxRef = useRef<AudioContext | null>(null);
  const seen = useRef<Set<string> | null>(null);

  const context = useCallback(() => {
    if (!ctxRef.current) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return null;
      ctxRef.current = new Ctx();
    }
    return ctxRef.current;
  }, []);

  // The first touch anywhere on the page unlocks sound.
  useEffect(() => {
    const unlock = () => {
      const ctx = context();
      if (!ctx) return;
      void ctx.resume().then(() => setBlocked(ctx.state !== 'running'));
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [context]);

  useEffect(() => () => void ctxRef.current?.close(), []);

  useEffect(() => {
    if (!newIds) return;
    if (!seen.current) {
      seen.current = new Set(newIds);
      return;
    }
    const fresh = newIds.filter((id) => !seen.current!.has(id));
    newIds.forEach((id) => seen.current!.add(id));
    const ctx = ctxRef.current;
    if (fresh.length && enabled && ctx?.state === 'running') playChime(ctx);
  }, [newIds, enabled]);

  const toggle = useCallback(() => {
    const next = !enabled;
    setEnabled(next);
    writeSetting(next);
    // Turning it on plays the chime once, so the kitchen knows what to listen for.
    const ctx = context();
    if (next && ctx) void ctx.resume().then(() => ctx.state === 'running' && playChime(ctx));
  }, [enabled, context]);

  return { enabled, blocked, toggle };
}
