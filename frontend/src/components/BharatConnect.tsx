import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Languages, Mic, Play, RotateCcw, Square, X } from 'lucide-react';
import { recordAudio } from '../lib/backend';
import { bharat, play, runTurn, type BharatStatus, type Lang, type SessionState, type Speaker, type Stage, type Turn } from '../lib/bharat';

const FALLBACK_LANGS = [
  { code: 'ta', name: 'Tamil', native: 'தமிழ்' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'en', name: 'English', native: 'English' },
] as const;
const STATE_LABEL: Record<SessionState, string> = {
  idle: 'Ready', recording: 'Listening…', transcribing: 'Transcribing…', translating: 'Translating…',
  generating_audio: 'Generating speech…', playing_audio: 'Playing translation', error: 'Needs attention',
};
const TURN_LABEL: Record<Turn['status'], string> = {
  transcribing: 'Transcribing…', translating: 'Translating…', generating_audio: 'Generating speech…',
  playing_audio: 'Playing', done: 'Done', error: 'Failed',
};
const ROLE: Record<Speaker, string> = { driver: 'Driver', passenger: 'Passenger' };
const OTHER: Record<Speaker, Speaker> = { driver: 'passenger', passenger: 'driver' };
const secs = (ms?: number) => (ms === undefined ? '–' : `${(ms / 1000).toFixed(1)} s`);

/** Two-way driver <-> passenger voice translation (alternating push-to-talk). */
export function BharatConnect({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<BharatStatus | null>(null);
  const [offline, setOffline] = useState(false);
  const [langs, setLangs] = useState<Record<Speaker, Lang>>({ driver: 'ta', passenger: 'hi' });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [rec, setRec] = useState<{ speaker: Speaker; stop: () => Promise<Blob> } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const nextId = useRef(1);
  const history = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const refresh = () => bharat.status().then((s) => { setStatus(s); setOffline(false); }).catch(() => setOffline(true));
    void refresh();
    void bharat.warmup().then(refresh); // load the speech model before the first turn
  }, []);
  useEffect(() => { history.current?.scrollTo({ top: history.current.scrollHeight, behavior: 'smooth' }); }, [turns]);

  const upsert = useCallback((t: Turn) => setTurns((ts) => ts.map((x) => (x.id === t.id ? t : x))), []);
  // `endedAt` (end of speech) starts the latency clock; a retry starts it when it begins.
  const run = useCallback(async (t: Turn, from: Stage, endedAt?: number) => {
    setBusy(t.id);
    await runTurn(t, from, endedAt ?? performance.now(), upsert);
    setBusy(null);
  }, [upsert]);

  // Recording, or any turn in flight (including playback), locks both microphones: no overlapping
  // requests, and the system never records its own translated speech.
  const locked = rec !== null || busy !== null;
  const active = turns.find((t) => t.id === busy);
  const last = turns[turns.length - 1];
  const state: SessionState = rec ? 'recording'
    : active && active.status !== 'done' ? (active.status as SessionState)
      : last?.status === 'error' ? 'error' : 'idle';

  const talk = async (speaker: Speaker) => {
    if (rec) { if (rec.speaker === speaker) void rec.stop(); return; }
    if (busy !== null) return;
    setMicError(null);
    let r: Awaited<ReturnType<typeof recordAudio>>;
    try {
      r = await recordAudio(15000, 900); // ends on a pause after speech, a second tap, or 15 s
    } catch {
      setMicError('The microphone is blocked or unavailable. Allow microphone access and try again.');
      return;
    }
    setRec({ speaker, stop: r.stop });
    const recording = await r.done;
    const endedAt = performance.now();
    setRec(null);
    const t: Turn = { id: nextId.current++, speaker, source: langs[speaker], target: langs[OTHER[speaker]], status: 'transcribing', timings: {}, recording };
    setTurns((ts) => [...ts, t]);
    await run(t, 'transcribing', endedAt);
  };

  const retry = (t: Turn) => {
    const stage = t.error?.stage;
    const from: Stage = stage === 'translating' ? 'translating' : stage === 'generating_audio' || stage === 'playing_audio' ? 'generating_audio' : 'transcribing';
    void run({ ...t, retried: true }, from);
  };
  const replay = (t: Turn) => {
    setBusy(t.id);
    let cur = t;
    void play(t, null, (patch) => { cur = { ...cur, ...patch, timings: { ...cur.timings, ...patch.timings } }; upsert(cur); })
      .then(() => setBusy(null));
  };
  const endSession = () => { setTurns([]); setMicError(null); };

  const languages = status?.languages ?? FALLBACK_LANGS;
  const langName = (c: Lang) => languages.find((l) => l.code === c)?.name ?? c;
  const problem = offline ? 'The BharatConnect server is not reachable. Start the backend and reopen this panel.'
    : status?.translation.problem ? `Translation is not set up on the server (${status.translation.problem}). See backend README → BharatConnect.`
      : micError;

  return (
    <div className="bc-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget && !locked) onClose(); }}>
      <section className="bc" role="dialog" aria-label="BharatConnect voice translation">
        <header className="bc-head">
          <Languages className="bc-logo" />
          <div className="bc-title"><b>BharatConnect</b><small>Driver ↔ passenger voice translation</small></div>
          <span className={`bc-state ${state}`} aria-live="polite">{STATE_LABEL[state]}</span>
          <button className="bc-tool" onClick={endSession} disabled={locked || !turns.length} title="Clear the conversation">
            <RotateCcw /><span>End session</span>
          </button>
          <button className="bc-tool" onClick={onClose} disabled={locked} aria-label="Close BharatConnect"><X /></button>
        </header>

        {problem && <p className="bc-problem"><AlertTriangle />{problem}</p>}

        <div className="bc-speakers">
          {(['driver', 'passenger'] as Speaker[]).map((sp) => {
            const mine = rec?.speaker === sp;
            return (
              <div key={sp} className={`bc-speaker ${sp} ${mine ? 'live' : ''}`}>
                <div className="bc-speaker-head">
                  <b>{ROLE[sp]}</b>
                  <select value={langs[sp]} disabled={locked} aria-label={`${ROLE[sp]} language`}
                    onChange={(e) => setLangs({ ...langs, [sp]: e.target.value as Lang })}>
                    {languages.map((l) => <option key={l.code} value={l.code}>{l.native === l.name ? l.name : `${l.name} · ${l.native}`}</option>)}
                  </select>
                </div>
                <button className="bc-ptt" onClick={() => void talk(sp)} disabled={locked && !mine}
                  aria-label={mine ? `Stop ${ROLE[sp]} recording` : `${ROLE[sp]}: speak`}>
                  {mine ? <Square /> : <Mic />}
                  {mine && <><i /><i /></>}
                </button>
                <small className="bc-hint">
                  {mine ? 'Listening… tap to stop' : locked ? 'Wait for the translation' : `Tap and speak ${langName(langs[sp])}`}
                </small>
                <small className="bc-to">heard in {langName(langs[OTHER[sp]])}</small>
              </div>
            );
          })}
        </div>

        <ol className="bc-history" ref={history} aria-label="Conversation">
          {!turns.length && <li className="bc-empty">Each turn appears here: what was said, its translation, and how long it took.</li>}
          {turns.map((t) => (
            <li key={t.id} className={`bc-turn ${t.speaker} ${t.status}`}>
              <div className="bc-meta">
                <b>{ROLE[t.speaker]}</b><span>{langName(t.source)} → {langName(t.target)}</span>
                <em>{TURN_LABEL[t.status]}</em>
              </div>
              <p className="bc-orig">{t.original ?? (t.status === 'transcribing' ? '…' : '')}</p>
              {t.translated && <p className="bc-trans" lang={t.target}>{t.translated}</p>}
              {t.error && (
                <p className="bc-err">
                  <AlertTriangle /><span>{t.error.message}</span>
                  {(t.error.retryable || t.error.stage !== 'transcribing') && (
                    <button onClick={() => retry(t)} disabled={locked}><RotateCcw />Retry</button>
                  )}
                </p>
              )}
              {t.speech && (t.needsPlay || t.status === 'done') && (
                <button className="bc-play" onClick={() => replay(t)} disabled={locked}>
                  <Play />{t.needsPlay ? 'Play translation' : 'Play again'}
                </button>
              )}
              {(t.timings.asr !== undefined || t.timings.total !== undefined) && (
                <div className="bc-lat" title="Measured in the browser. Total runs from the end of speech until the translation starts playing.">
                  ASR {secs(t.timings.asr)} · Translate {secs(t.timings.translate)} · Speech {secs(t.timings.tts)} ·{' '}
                  <b>Total {secs(t.timings.total)}</b>{t.retried && ' (after retry)'}
                </div>
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
