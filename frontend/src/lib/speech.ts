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

let voices: SpeechSynthesisVoice[] = [];
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  const load = () => { voices = window.speechSynthesis.getVoices(); };
  load();
  window.speechSynthesis.addEventListener?.('voiceschanged', load);
}

/** Speaks a reply with an Indian-English voice when available (it reads Hinglish naturally). */
export function speak(text: string, onStart?: () => void, onEnd?: () => void) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    onEnd?.();
    return;
  }
  window.speechSynthesis.cancel();
  if (window.speechSynthesis.paused) {
    try { window.speechSynthesis.resume(); } catch { /* ignore */ }
  }
  if (voices.length === 0) {
    try { voices = window.speechSynthesis.getVoices(); } catch { /* ignore */ }
  }
  const u = new SpeechSynthesisUtterance(text.replace(/°C/g, ' degrees'));
  const voice =
    voices.find((v) => v.lang === 'en-IN' && /female|heera|neerja|veena|google/i.test(v.name)) ??
    voices.find((v) => v.lang === 'en-IN') ??
    voices.find((v) => v.lang.startsWith('en'));
  if (voice) u.voice = voice;
  u.lang = voice?.lang ?? 'en-IN';
  u.rate = 1.0;
  u.pitch = 1.02;
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
