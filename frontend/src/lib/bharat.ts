// BharatConnect: two-way voice translation between driver and passenger.
// One turn = recording -> /bharat/transcribe -> /bharat/translate -> /bharat/speak -> playback. Each stage is
// its own request, so the UI shows the stage and a failed turn retries only from the stage that failed.
// Translation and speech credentials stay on the backend.

import { API } from './backend';

export type Lang = 'ta' | 'hi' | 'en' | 'bn';
export type Speaker = 'driver' | 'passenger';
export type Stage = 'transcribing' | 'translating' | 'generating_audio';
/** Session states; `recording` and `playing_audio` lock both microphones. */
export type SessionState = 'idle' | 'recording' | Stage | 'playing_audio' | 'error';

export interface LanguageInfo { code: Lang; name: string; native: string }
export interface BharatStatus {
  languages: LanguageInfo[];
  asr: { model: string; loaded: boolean };
  translation: { problem: string | null };
}

export interface TurnError { stage: Stage | 'playing_audio' | 'input'; message: string; retryable: boolean }

export interface Turn {
  id: number;
  speaker: Speaker;
  source: Lang;
  target: Lang;
  status: Stage | 'playing_audio' | 'done' | 'error';
  original?: string;
  translated?: string;
  /** Milliseconds measured in the browser: each stage's round trip, and `total` from the end of the
   *  utterance until the translated audio starts playing (or until the text is ready, without audio). */
  timings: { asr?: number; translate?: number; tts?: number; total?: number };
  error?: TurnError;
  /** Autoplay was blocked: the UI offers a play button. */
  needsPlay?: boolean;
  /** Re-run after a failure: `total` then counts from the retry, not from the end of speech. */
  retried?: boolean;
  // Kept in memory only (never uploaded again unless retried, never stored): the recording and the speech.
  recording?: Blob;
  speech?: Blob;
}

class StageError extends Error {
  readonly detail: TurnError;
  constructor(detail: TurnError) {
    super(detail.message);
    this.detail = detail;
  }
}

async function request(stage: Stage, path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${API}/bharat${path}`, { ...init, signal: ctrl.signal });
  } catch {
    throw new StageError({ stage, message: ctrl.signal.aborted ? 'The server took too long. Retry.' : 'Cannot reach the BharatConnect server.', retryable: true });
  } finally {
    window.clearTimeout(t);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const d = body?.detail;
    throw new StageError(typeof d === 'object' && d?.message
      ? { stage, message: d.message, retryable: !!d.retryable }
      : { stage, message: `Server error (HTTP ${res.status}).`, retryable: res.status >= 500 });
  }
  return res;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const bharat = {
  status: async (): Promise<BharatStatus> => (await fetch(`${API}/bharat/status`)).json(),
  /** Load the speech model ahead of the first turn. */
  warmup: () => fetch(`${API}/bharat/warmup`, { method: 'POST' }).catch(() => undefined),
};

async function transcribe(audio: Blob, lang: Lang): Promise<{ text: string; language?: string }> {
  const fd = new FormData();
  const ext = audio.type.includes('mp4') ? 'mp4' : audio.type.includes('ogg') ? 'ogg' : 'webm';
  fd.append('file', audio, `turn.${ext}`);
  fd.append('language', lang);
  const r: { text: string; status: string; language?: string } = await (await request('transcribing', '/transcribe', { method: 'POST', body: fd }, 60000)).json();
  if (!r.text.trim()) {
    throw new StageError({ stage: 'transcribing', message: 'No speech was heard. Hold the button closer and speak again.', retryable: false });
  }
  return { text: r.text.trim(), language: r.language };
}

async function translate(text: string, source: Lang, target: Lang): Promise<string> {
  return (await (await request('translating', '/translate', json({ text, source, target }), 15000)).json()).text;
}

async function speak(text: string, lang: Lang): Promise<Blob> {
  return (await request('generating_audio', '/speak', json({ text, language: lang }), 20000)).blob();
}

/**
 * Run (or resume) a turn from `from`, reporting every change through `update`. Resolves once the translated
 * audio has finished playing, autoplay was blocked, or a stage failed (recorded on the turn, never thrown).
 * `endedAt` is when the speaker finished (performance.now()), the start of the end-to-end latency.
 */
export async function runTurn(turn: Turn, from: Stage, endedAt: number, update: (t: Turn) => void): Promise<boolean> {
  let t: Turn = { ...turn, error: undefined, needsPlay: false };
  const set = (patch: Partial<Turn>) => { t = { ...t, ...patch, timings: { ...t.timings, ...patch.timings } }; update(t); };
  const timed = async <T>(key: 'asr' | 'translate' | 'tts', fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    const out = await fn();
    set({ timings: { [key]: Math.round(performance.now() - t0) } });
    return out;
  };
  try {
    if (from === 'transcribing') {
      set({ status: 'transcribing' });
      const asr = await timed('asr', () => transcribe(t.recording!, t.source));
      t.original = asr.text;
      set({ original: asr.text });
      if (asr.language) {
        const detected = asr.language.split('-')[0] as Lang;
        if (['hi', 'ta', 'en', 'bn'].includes(detected) && detected !== t.target) {
          t.source = detected;
          set({ source: detected });
        }
      }
    }
    if (from !== 'generating_audio') {
      set({ status: 'translating' });
      const targetLang = t.source === t.target ? (t.target === 'en' ? 'hi' : 'en') : t.target;
      t.target = targetLang;
      set({ translated: await timed('translate', () => translate(t.original!, t.source, targetLang)), target: targetLang });
    }
    set({ status: 'generating_audio' });
    set({ speech: await timed('tts', () => speak(t.translated!, t.target)) });
  } catch (e) {
    const detail = e instanceof StageError ? e.detail : { stage: t.status as Stage, message: String(e), retryable: true };
    // The translated text is still shown when only the speech failed.
    set({ status: 'error', error: detail, timings: { total: t.translated ? Math.round(performance.now() - endedAt) : undefined } });
    return false;
  }
  await play(t, endedAt, set);
  return t.status === 'done' && !t.error && !t.needsPlay;
}

/** Play the turn's speech; records the latency when sound starts and frees the audio when it ends. */
export function play(t: Turn, endedAt: number | null, set: (patch: Partial<Turn>) => void): Promise<void> {
  const url = URL.createObjectURL(t.speech!);
  const audio = new Audio(url);
  return new Promise((resolve) => {
    let settled = false; // clearing `src` below can fire one more error event
    const finish = (patch: Partial<Turn>) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      audio.removeAttribute('src');
      set(patch);
      resolve();
    };
    audio.onplaying = () => set({ status: 'playing_audio', ...(endedAt !== null ? { timings: { total: Math.round(performance.now() - endedAt) } } : {}) });
    audio.onended = () => finish({ status: 'done' });
    audio.onerror = () => finish({ status: 'error', error: { stage: 'playing_audio', message: 'The speech could not be played.', retryable: true } });
    audio.play().catch((err: DOMException) => {
      // Browsers may block sound that no tap started: offer a play button instead.
      if (err.name === 'NotAllowedError') finish({ status: 'done', needsPlay: true });
      else finish({ status: 'error', error: { stage: 'playing_audio', message: 'The speech could not be played.', retryable: true } });
    });
  });
}
