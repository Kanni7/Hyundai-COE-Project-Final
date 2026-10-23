import { useCallback, useEffect, useRef, useState } from 'react';

// Minimal typings for the Web Speech API (not in lib.dom for all TS versions).
interface RecognitionResult { isFinal: boolean; 0: { transcript: string } }
interface RecognitionEvent { resultIndex: number; results: ArrayLike<RecognitionResult> }
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}
type RecognitionCtor = new () => Recognition;

const Ctor: RecognitionCtor | undefined =
  typeof window !== 'undefined'
    ? ((window as unknown as Record<string, RecognitionCtor | undefined>).SpeechRecognition ??
      (window as unknown as Record<string, RecognitionCtor | undefined>).webkitSpeechRecognition)
    : undefined;

export const speechSupported = !!Ctor;

/**
 * `onError` gets the raw Web Speech error code (e.g. 'network' when the browser's cloud
 * recogniser is unreachable) and returns true if it handled it, which hides the message.
 */
export function useSpeechRecognition(onFinal: (text: string) => void, onError?: (code: string) => boolean) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const finalRef = useRef('');
  const cb = useRef(onFinal);
  useEffect(() => { cb.current = onFinal; }, [onFinal]);
  const errCb = useRef(onError);
  useEffect(() => { errCb.current = onError; }, [onError]);

  const stop = useCallback(() => rec.current?.stop(), []);

  const start = useCallback((lang: string) => {
    if (!Ctor) return;
    rec.current?.abort();
    const r = new Ctor();
    r.lang = lang;
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    finalRef.current = '';
    r.onresult = (e) => {
      let text = '';
      let final = '';
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) final += res[0].transcript;
        else text += res[0].transcript;
      }
      if (final) finalRef.current = final;
      setInterim(final || text);
    };
    r.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        if (errCb.current?.(e.error)) return;
        setError(
          e.error === 'not-allowed' ? 'Microphone permission denied'
            : e.error === 'network' ? "The browser's speech service is unreachable. Type the command instead."
              : `Speech error: ${e.error}`,
        );
      }
    };
    r.onend = () => {
      setListening(false);
      setInterim('');
      const text = finalRef.current.trim();
      if (text) cb.current(text);
    };
    rec.current = r;
    setError(null);
    setListening(true);
    r.start();
  }, []);

  return { listening, interim, error, start, stop, supported: speechSupported };
}
// ═════════════════════════════════════════════════════════════════════
// Authentic Indian Voice Synthesis Engine (Text-To-Speech)
// ═════════════════════════════════════════════════════════════════════

let voices: SpeechSynthesisVoice[] = [];
const VOICE_PREF_KEY = 'bhashadrive-voice-pref';

function loadVoices(): SpeechSynthesisVoice[] {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      const v = window.speechSynthesis.getVoices();
      if (v.length > 0) voices = v;
    } catch {
      /* ignore */
    }
  }
  return voices;
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  loadVoices();
  window.speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}

/** Check if a string contains Hindi / Devanagari characters. */
export function hasDevanagari(text: string): boolean {
  return /[ऀ-ॿ]/.test(text);
}

/** Check if a voice is an Indian voice based on language code or name keywords. */
export function isIndianVoice(v: SpeechSynthesisVoice): boolean {
  const name = (v.name || '').toLowerCase();
  const lang = (v.lang || '').toLowerCase().replace(/_/g, '-');
  return (
    lang === 'en-in' ||
    lang === 'hi-in' ||
    lang === 'hi' ||
    lang.endsWith('-in') ||
    name.includes('india') ||
    name.includes('hindi') ||
    name.includes('heera') ||
    name.includes('neerja') ||
    name.includes('ravi') ||
    name.includes('swara') ||
    name.includes('prabhat') ||
    name.includes('madhur') ||
    name.includes('kalpana') ||
    name.includes('hemant') ||
    name.includes('veena')
  );
}

export function getAvailableVoices(): SpeechSynthesisVoice[] {
  if (voices.length === 0) loadVoices();
  return voices;
}

export function getIndianVoices(): SpeechSynthesisVoice[] {
  const all = getAvailableVoices();
  const indian = all.filter(isIndianVoice);
  return indian.length > 0 ? indian : all.filter((v) => (v.lang || '').toLowerCase().startsWith('en'));
}

export function getVoicePreference(): string {
  try {
    return localStorage.getItem(VOICE_PREF_KEY) || 'female';
  } catch {
    return 'female';
  }
}

export function setVoicePreference(pref: string): void {
  try {
    localStorage.setItem(VOICE_PREF_KEY, pref);
  } catch {
    /* ignore */
  }
}

/** Score a voice by how authentic, natural, and suited it is for Indian drivers. */
function scoreVoice(v: SpeechSynthesisVoice, pref: string, textSample = ''): number {
  const name = (v.name || '').toLowerCase();
  const lang = (v.lang || '').toLowerCase().replace(/_/g, '-');
  const isDeva = hasDevanagari(textSample);

  // If user selected a specific voice by full name or URI
  if (pref !== 'female' && pref !== 'male' && pref !== 'auto') {
    if (v.name === pref || v.voiceURI === pref) return 10000;
  }

  const isFemale = /female|woman|neerja|swara|heera|veena|kalpana|zira|hazel/i.test(name);
  const isMale = /male|man|prabhat|madhur|ravi|hemant|david|george/i.test(name);
  const isIndian = isIndianVoice(v);

  let score = 0;
  if (isIndian) score += 1000;

  // Natural/Neural Indian voices (Microsoft Online Natural / Edge voices)
  if (name.includes('natural') || name.includes('neural')) score += 300;

  // Top Indian TTS models
  if (name.includes('neerja')) score += 250;   // Microsoft Neerja (English India Natural Female)
  if (name.includes('swara')) score += 230;    // Microsoft Swara (Hindi Natural Female)
  if (name.includes('heera')) score += 200;    // Microsoft Heera (Windows Indian English Female)
  if (name.includes('prabhat')) score += 220;  // Microsoft Prabhat (English India Natural Male)
  if (name.includes('madhur')) score += 210;   // Microsoft Madhur (Hindi Natural Male)
  if (name.includes('ravi')) score += 190;     // Microsoft Ravi (Windows Indian English Male)
  if (name.includes('google') && isIndian) score += 150;

  // Match requested gender preference
  if (pref === 'female' && isFemale) score += 400;
  if (pref === 'male' && isMale) score += 400;

  // Script & Language alignment
  if (isDeva) {
    if (lang === 'hi-in' || lang === 'hi' || /hindi|swara|madhur/.test(name)) {
      score += 600;
    }
  } else {
    // Latin text (Indian English or Hinglish in Latin script)
    if (lang === 'en-in' || /neerja|heera|prabhat|ravi/.test(name)) {
      score += 400;
    }
  }

  // Fallbacks: British English sounds closer to Indian accent than US English
  if (lang.startsWith('en-gb') || /hazel|george|susan/i.test(name)) score += 30;
  if (lang.startsWith('en')) score += 15;

  return score;
}

export function pickBestVoice(pref = getVoicePreference(), textSample = ''): SpeechSynthesisVoice | undefined {
  if (voices.length === 0) loadVoices();
  if (voices.length === 0) return undefined;

  const sorted = [...voices].sort((a, b) => scoreVoice(b, pref, textSample) - scoreVoice(a, pref, textSample));
  return sorted[0];
}

/** Hook for UI components to read and set the Indian voice preference. */
export function useSpeechVoices() {
  const [pref, setPrefState] = useState<string>(() => getVoicePreference());
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>(() => getAvailableVoices());

  useEffect(() => {
    const update = () => {
      setAvailableVoices(getAvailableVoices());
    };
    update();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.addEventListener?.('voiceschanged', update);
      return () => {
        window.speechSynthesis.removeEventListener?.('voiceschanged', update);
      };
    }
  }, []);

  const setPref = useCallback((p: string) => {
    setVoicePreference(p);
    setPrefState(p);
  }, []);

  const activeVoice = pickBestVoice(pref);

  return { pref, setPref, availableVoices, activeVoice };
}

/** Speaks a reply using an authentic Indian voice. */
export function speak(
  text: string,
  onStart?: () => void,
  onEnd?: () => void,
  prefOverride?: string
) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    onEnd?.();
    return;
  }
  window.speechSynthesis.cancel();
  if (window.speechSynthesis.paused) {
    try { window.speechSynthesis.resume(); } catch { /* ignore */ }
  }
  if (voices.length === 0) {
    loadVoices();
  }

  // Pre-process spoken automotive text for natural Indian pronunciation:
  const cleanText = text
    .replace(/°C/gi, ' degrees')
    .replace(/km\/h/gi, ' kilometers per hour')
    .replace(/psi/gi, 'P S I')
    .replace(/ACC/g, 'Accessory mode')
    .replace(/\s+/g, ' ')
    .trim();

  const u = new SpeechSynthesisUtterance(cleanText);
  const voice = pickBestVoice(prefOverride, cleanText);
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang || (hasDevanagari(cleanText) ? 'hi-IN' : 'en-IN');
  } else {
    u.lang = hasDevanagari(cleanText) ? 'hi-IN' : 'en-IN';
  }

  // Cadence tuned for clear, warm Indian delivery
  u.rate = 0.96;
  u.pitch = 1.0;

  let done = false;
  const finish = () => {
    if (!done) {
      done = true;
      onEnd?.();
    }
  };
  u.onstart = () => onStart?.();
  u.onend = () => finish();
  u.onerror = () => finish();

  // 50ms tick bypasses the Chromium cancel()->speak() race condition
  window.setTimeout(() => {
    try {
      window.speechSynthesis.resume();
      window.speechSynthesis.speak(u);
    } catch {
      finish();
    }
  }, 50);
}

/** Play a short voice sample so the user can preview the selected Indian voice. */
export function testVoiceSample(pref?: string) {
  const chosenPref = pref ?? getVoicePreference();
  const v = pickBestVoice(chosenPref);
  const isHi = v && (v.lang?.toLowerCase().startsWith('hi') || /hindi|swara|madhur/i.test(v.name));
  const sample = isHi
    ? 'Namaste! Hyundai Verna voice assistant aapke sewa mein hazir hai.'
    : 'Namaste! Welcome to your Hyundai Verna.';
  speak(sample, undefined, undefined, chosenPref);
}
