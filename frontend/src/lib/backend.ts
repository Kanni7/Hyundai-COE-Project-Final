// Client for the BhashaDrive backend (../backend, FastAPI). The backend owns the
// voice NLU for its whitelisted domain (climate, fan, volume, media, navigation):
// negation, confirmations, personal shortcuts and parameter validation. The local
// parser handles everything else, and everything when the backend is unreachable.
// Sentences neither can read with confidence go to the backend's command LLM (`interpret`).

import type { Intent, ProfileId } from '../types';

export const API = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';
const TIMEOUT_MS = 4000;
const TRANSCRIBE_TIMEOUT_MS = 30000; // CPU speech recognition takes a few seconds per utterance
const INTERPRET_TIMEOUT_MS = 8000; // the command LLM: ~0.3-1 s on a laptop CPU
const WIND_TEST_TIMEOUT_MS = 90000; // the wind test performs three ASR passes

export interface BackendHealth {
  nlu: string;
  asr: string | null;
  asr_ready: boolean;
  /** The command LLM (fallback interpreter) is loaded. */
  llm_ready?: boolean;
  vehicle: string;
  mock: boolean;
}

type Amount = 'small' | 'medium' | 'large';

export interface BackendResult {
  transcript: string;
  intent: string | null;
  decision: 'execute' | 'ask_confirmation' | 'clarify' | 'reject' | 'saved';
  reason_code: string;
  response_text: string;
  source: string;
  negated: boolean;
  action: {
    intent: string;
    parameters: { amount?: Amount | null; target_temperature_celsius?: number | null; destination?: string | null };
  } | null;
}

export interface Transcription {
  /** Recogniser output after phonetic + attention rescoring: what the command model sees. */
  text: string;
  /** Every distinct rescored decoding pass, `text` first (ranked by the backend's climate/media classifier). */
  hypotheses?: string[];
  status: string;
  error: string | null;
  engine: string | null;
  /** Driver recognised from the voice (enrolled voiceprints), or null when unsure or nobody is enrolled. */
  speaker?: { profile: ProfileId; score: number } | null;
}

export interface SpeakerStatus {
  /** Speaker model installed on the backend. */
  ready: boolean;
  /** Enrolled sentences per profile. */
  enrolled: Partial<Record<ProfileId, number>>;
}

export interface WindSettings {
  enabled: boolean;
  strength: number;
  max_attenuation_db: number;
}

export interface WindTestVariant {
  text: string;
  status: string;
  error: string | null;
  language: string | null;
  latency_s: number | null;
}

export interface WindTestResult {
  wind_level_db: number;
  settings: WindSettings;
  clean: WindTestVariant;
  noisy_without_suppression: WindTestVariant;
  noisy_with_suppression: WindTestVariant;
}

async function call<T>(path: string, init?: RequestInit, timeoutMs = TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}${path}`, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    window.clearTimeout(t);
  }
}

export const backend = {
  health: () => call<BackendHealth>('/health'),
  reset: () => call<{ ok: boolean }>('/reset', { method: 'POST' }),
  windSettings: () => call<WindSettings>('/wind-settings'),
  updateWindSettings: (settings: WindSettings) =>
    call<WindSettings>('/wind-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }),
  text: (text: string) =>
    call<BackendResult>('/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }),
  /** Any sentence -> cockpit commands, by the command LLM. The backend validates every command. */
  interpret: (text: string) =>
    call<{ intents: Intent[]; latency_s: number }>('/interpret', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }, INTERPRET_TIMEOUT_MS),
  /** The backend decodes Hindi and English passes itself and returns the one the command model reads best. */
  transcribe: (audio: Blob) => {
    const fd = new FormData();
    const ext = audio.type.includes('mp4') ? 'mp4' : audio.type.includes('ogg') ? 'ogg' : 'webm';
    fd.append('file', audio, `speech.${ext}`);
    return call<Transcription>('/transcribe', { method: 'POST', body: fd }, TRANSCRIBE_TIMEOUT_MS);
  },
  windTest: (audio: Blob, windLevelDb = 6) => {
    const fd = new FormData();
    const ext = audio.type.includes('mp4') ? 'mp4' : audio.type.includes('ogg') ? 'ogg' : 'webm';
    fd.append('file', audio, `wind-test.${ext}`);
    fd.append('wind_level_db', String(windLevelDb));
    return call<WindTestResult>('/wind-test', { method: 'POST', body: fd }, WIND_TEST_TIMEOUT_MS);
  },
  speakers: () => call<SpeakerStatus>('/speaker'),
  /** Adds one spoken sentence to a profile's voiceprint (the backend keeps only the embedding). */
  enroll: async (profile: ProfileId, audio: Blob) => {
    const fd = new FormData();
    fd.append('file', audio, `voice.${audio.type.includes('mp4') ? 'mp4' : audio.type.includes('ogg') ? 'ogg' : 'webm'}`);
    const res = await fetch(`${API}/speaker/${profile}`, { method: 'POST', body: fd });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.detail ?? `HTTP ${res.status}`);
    return j as { profile: ProfileId; samples: number };
  },
  forget: (profile: ProfileId) => call<{ samples: number }>(`/speaker/${profile}`, { method: 'DELETE' }),
};

/** Frontend intent types whose meaning the backend NLU covers. */
export const BACKEND_DOMAIN = new Set<Intent['type']>([
  'climate.setTemp', 'climate.adjustTemp', 'climate.power', 'climate.fan',
  'media.play', 'media.pause', 'media.skip', 'media.volume', 'nav.start',
]);

// Same small / normal / big steps as the local parser.
const STEP = { temp: [1, 2, 3], fan: [1, 1, 3], volume: [2, 4, 8] } as const;
const size = (kind: keyof typeof STEP, a?: Amount | null) => STEP[kind][a === 'small' ? 0 : a === 'large' ? 2 : 1];

/** Maps a validated backend vehicle action onto the cockpit's intent contract. */
export function toIntent(action: NonNullable<BackendResult['action']>): Intent | null {
  const p = action.parameters;
  switch (action.intent) {
    case 'climate_temperature_up': return { type: 'climate.adjustTemp', delta: size('temp', p.amount) };
    case 'climate_temperature_down': return { type: 'climate.adjustTemp', delta: -size('temp', p.amount) };
    case 'climate_temperature_set':
      return p.target_temperature_celsius != null ? { type: 'climate.setTemp', value: p.target_temperature_celsius } : null;
    case 'climate_fan_speed_up': return { type: 'climate.fan', delta: size('fan', p.amount) };
    case 'climate_fan_speed_down': return { type: 'climate.fan', delta: -size('fan', p.amount) };
    case 'climate_on': return { type: 'climate.power', on: true };
    case 'climate_off': return { type: 'climate.power', on: false };
    case 'volume_up': return { type: 'media.volume', delta: size('volume', p.amount) };
    case 'volume_down': return { type: 'media.volume', delta: -size('volume', p.amount) };
    case 'media_play': return { type: 'media.play' };
    case 'media_pause': return { type: 'media.pause' };
    case 'media_next': return { type: 'media.skip', dir: 1 };
    case 'media_previous': return { type: 'media.skip', dir: -1 };
    case 'navigation_destination_request':
      return p.destination ? { type: 'nav.start', destination: titleCase(p.destination) } : null;
    default: return null;
  }
}

const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (ch) => ch.toUpperCase());

/**
 * Records one utterance from the microphone. It ends on `stop()`, after `silenceMs` of quiet
 * once speech was heard (like the browser recogniser does), or at `maxMs`.
 */
export interface RecordAudioOptions {
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

export async function recordAudio(maxMs = 8000, silenceMs = 900, options: RecordAudioOptions = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: options.noiseSuppression ?? true,
      // Do not let browser AGC amplify a quiet wind burst before the server's
      // adaptive low-frequency suppression gets a chance to process it.
      autoGainControl: options.autoGainControl ?? false,
      channelCount: 1,
    },
  });
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

  // Energy-based end-of-speech detection. The threshold follows the background noise level,
  // so quiet laptop mics and noisy cabins both work.
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let heard = false;
  let floor = 0.005;
  let quietSince = performance.now();
  const vad = window.setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const level = Math.sqrt(sum / buf.length);
    const loud = level > Math.max(0.008, floor * 3);
    if (!loud) floor = floor * 0.9 + level * 0.1;
    const now = performance.now();
    if (loud) { heard = true; quietSince = now; }
    else if (heard && now - quietSince > silenceMs) stop();
  }, 100);

  const done = new Promise<Blob>((resolve) => {
    rec.onstop = () => {
      window.clearInterval(vad);
      void ctx.close();
      stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
    };
  });
  const timer = window.setTimeout(() => stop(), maxMs);
  function stop() {
    window.clearTimeout(timer);
    if (rec.state !== 'inactive') rec.stop();
    return done;
  }
  rec.start();
  return { stop, done };
}
