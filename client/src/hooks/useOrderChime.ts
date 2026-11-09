/**
 * Food alerts: a chime when something new shows up (a new order for the kitchen, Ready food for
 * waiters and the counter), and a shorter, softer sound when Ready food leaves (served at a table
 * or a parcel handed over). The sounds are short WAV clips made in the browser and played like any
 * audio file (no file to download).
 *
 * Kept once per browser tab, not per screen: the dashboard frame is rebuilt when moving between
 * some pages, and the sound must keep working (and keep knowing what it already rang for) across
 * that. Browsers only allow sound after the person has touched the page once; `blocked` is true
 * until then.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

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

// ---- One sound state for the whole tab ----
let state = { enabled: readSetting(), blocked: true };
const listeners = new Set<() => void>();
/** What already rang, per login + branch, so a rebuilt screen does not ring again for it. */
const seenByKey = new Map<string, Set<string>>();
/** The Ready food last seen, per login + branch: what is gone since was served / handed over. */
const readyByKey = new Map<string, Set<string>>();
/** Tickets this tab served or handed over itself: no sound for one's own tap. */
const ownActions = new Set<string>();

/** Food this tab marked Ready itself: its own "done" sound plays, not the "food ready" chime too. */
const ownReady = new Set<string>();

/** Call before serving / handing over a ticket from this screen, so it does not ring here. */
export function markOwnAction(ticketId: string) {
  ownActions.add(ticketId);
}

/** This screen just marked food Ready (these tickets): a short "done" sound, if sound is on. */
export function playReadyDone(ticketIds: string[]) {
  ticketIds.forEach((id) => ownReady.add(id));
  if (state.enabled) playChime('ready');
}

function set(next: Partial<typeof state>) {
  if (Object.entries(next).every(([k, v]) => state[k as keyof typeof state] === v)) return;
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const snapshot = () => state;

// ---- The sounds: short WAV clips made here once, played like any audio file ----
type Sound = 'arrived' | 'gone' | 'ready';
const ALL_SOUNDS: Sound[] = ['arrived', 'gone', 'ready'];
/**
 * Notes (Hz) and when each starts (s). Arrived: two rising tones, twice. Gone: one falling pair.
 * Ready: three quick rising notes – the kitchen's own "done" when it marks food Ready.
 */
const SOUNDS: Record<Sound, { notes: number[]; at: (i: number) => number; volume: number }> = {
  arrived: {
    notes: [880, 1320, 880, 1320],
    at: (i) => i * 0.18 + (i >= 2 ? 0.25 : 0),
    volume: 0.8,
  },
  gone: { notes: [1175, 784], at: (i) => i * 0.2, volume: 0.6 },
  ready: { notes: [1047, 1319, 1568], at: (i) => i * 0.11, volume: 0.7 },
};

/** 16-bit mono WAV of the notes, each a sine with a quick rise and a 0.35 s fade. */
function wavUrl(sound: Sound): string {
  const { notes, at, volume } = SOUNDS[sound];
  const rate = 22050;
  const length = Math.ceil((at(notes.length - 1) + 0.45) * rate);
  const samples = new Float32Array(length);
  notes.forEach((freq, n) => {
    const from = Math.floor(at(n) * rate);
    for (let i = 0; i < 0.4 * rate && from + i < length; i++) {
      const t = i / rate;
      const envelope = t < 0.015 ? t / 0.015 : Math.exp(-(t - 0.015) * 12);
      samples[from + i] += Math.sin(2 * Math.PI * freq * t) * envelope * volume;
    }
  });
  const buffer = new ArrayBuffer(44 + length * 2);
  const v = new DataView(buffer);
  const text = (o: number, str: string) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + length * 2, true);
  text(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, length * 2, true);
  samples.forEach((x, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 0x7fff, true));
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

type Player = {
  el: HTMLAudioElement;
  priming: Promise<void> | null;
  primed: boolean;
};
const players = new Map<Sound, Player>();
function player(sound: Sound): Player {
  let p = players.get(sound);
  if (!p) {
    const el = new Audio(wavUrl(sound));
    el.preload = 'auto';
    p = { el, priming: null, primed: false };
    players.set(sound, p);
  }
  return p;
}

/** Has the page been tapped yet? (Browsers allow sound only after that.) */
let tapped = false;
const allowed = () => navigator.userActivation?.hasBeenActive ?? tapped;

/**
 * During a tap: sound is now allowed, and each clip is played once silently (phones allow a clip
 * only after it has played during a tap). A clip that is busy playing is left alone.
 */
function onTap() {
  tapped = true;
  if (!allowed()) return;
  set({ blocked: false });
  for (const sound of ALL_SOUNDS) {
    const p = player(sound);
    if (p.primed || p.priming) continue;
    p.el.muted = true;
    p.priming = p.el
      .play()
      .then(() => {
        p.el.pause();
        p.el.currentTime = 0;
        p.primed = true;
      })
      .catch(() => undefined)
      .finally(() => {
        p.el.muted = false;
        p.priming = null;
      });
  }
}

if (typeof window !== 'undefined') {
  // Phones count a tap only when the finger lifts (touchend / pointerup / click), mice on press.
  // A tap on the Sound switch is left to the switch itself (see FoodAlerts).
  for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
    window.addEventListener(
      type,
      (e) => {
        if (!(e.target instanceof Element && e.target.closest('.sound-switch'))) onTap();
      },
      { capture: true, passive: true },
    );
  }
}

function playChime(sound: Sound = 'arrived') {
  if (state.blocked) return;
  const p = player(sound);
  const play = () => {
    p.el.muted = false;
    p.el.currentTime = 0;
    // Refused because the page needs a tap again: wait for one. Other errors do not stop later sounds.
    return p.el.play().catch((e: unknown) => {
      if (e instanceof DOMException && e.name === 'NotAllowedError') set({ blocked: true });
    });
  };
  void (p.priming ? p.priming.then(play) : play());
}

/**
 * Plays the chime when an id shows up in `ids` that was not there before. The ids present when
 * a login + branch (`key`) is first seen in this tab never ring: they were already waiting.
 * `ready` (optional) is the Ready food on screen: one that leaves it – served or handed over by
 * someone else – plays the softer sound. `onArrive` gets the ids that just arrived (for a popup),
 * whether or not the sound is on.
 */
export function useOrderChime(ids: string[] | undefined, key: string, ready?: string[], onArrive?: (ids: string[]) => void) {
  const { enabled } = useSyncExternalStore(subscribe, snapshot);
  const arrive = useRef(onArrive);
  useEffect(() => {
    arrive.current = onArrive;
  });

  // A screen rebuilt after the page was already touched can play sound straight away.
  useEffect(() => {
    if (navigator.userActivation?.hasBeenActive) set({ blocked: false });
  }, []);

  useEffect(() => {
    if (!ids) return;
    const seen = seenByKey.get(key);
    if (!seen) {
      seenByKey.set(key, new Set(ids));
      return;
    }
    const fresh = ids.filter((id) => !seen.has(id) && !ownReady.has(id));
    ids.forEach((id) => seen.add(id));
    if (!fresh.length) return;
    if (state.enabled) playChime();
    arrive.current?.(fresh);
  }, [ids, key]);

  useEffect(() => {
    if (!ready) return;
    const before = readyByKey.get(key);
    readyByKey.set(key, new Set(ready));
    if (!before) return;
    const now = new Set(ready);
    const gone = [...before].filter((id) => !now.has(id) && !ownActions.has(id));
    if (gone.length && state.enabled) playChime('gone');
  }, [ready, key]);

  /** The Sound switch was tapped: on ↔ off. Turning it on plays the chime once. */
  const press = useCallback(() => {
    onTap();
    const next = !state.enabled;
    writeSetting(next);
    set({ enabled: next });
    if (next) playChime();
  }, []);

  return { enabled, press };
}
