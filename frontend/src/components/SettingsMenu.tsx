import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FlaskConical, Layers, Maximize, MessageSquareText, Settings, Volume2, Wind } from 'lucide-react';
import { useSpeechVoices, testVoiceSample } from '../lib/speech';
import type { Entitlement, WindSettings, WindTestResult } from '../lib/backend';

interface Props {
  /** Connection line, e.g. "BhashaDrive NLU · English · हिन्दी · Hinglish"; `detail` goes in its tooltip. */
  status: { text: string; online: boolean; detail: string };
  /** Voice tier, as the backend decided it; null while the backend is unreachable. */
  voiceTier: Entitlement | null;
  /** Development only (backend BD_DEV_TIER_SWITCH): switch this cockpit between Free and Premium. */
  onDevTier: (tier: 'free' | 'premium') => void;
  speechLang: 'en-IN' | 'hi-IN';
  onLang: (l: 'en-IN' | 'hi-IN') => void;
  tts: boolean;
  onTts: (v: boolean) => void;
  /** Speech recogniser choice, shown only when both the browser and the backend can transcribe. */
  asr?: 'browser' | 'server';
  onAsr: (a: 'browser' | 'server') => void;
  sceneLabel: string;
  onNextScene: () => void;
  showLog: boolean;
  onLog: (v: boolean) => void;
  windSettings: WindSettings | null;
  windSaving: boolean;
  onWindSettings: (patch: Partial<WindSettings>) => void;
  browserNoiseSuppression: boolean;
  onBrowserNoiseSuppression: (v: boolean) => void;
  autoGainControl: boolean;
  onAutoGainControl: (v: boolean) => void;
  windTestLevelDb: number;
  onWindTestLevelDb: (v: number) => void;
  windTestBusy: boolean;
  windTestError: string | null;
  windTestResult: WindTestResult | null;
  onWindTest: () => void;
}

/** Everything the driver rarely touches, behind one button: language, voice replies, scene, log, debug. */
export function SettingsMenu(p: Props) {
  const [open, setOpen] = useState(false);
  const { pref: voicePref, setPref: setVoicePref, activeVoice } = useSpeechVoices();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div className="settings" ref={root}>
      <button className={open ? 'on' : ''} onClick={() => setOpen(!open)} title="Settings" aria-label="Settings" aria-expanded={open}>
        <Settings />
      </button>
      {open && (
        <div className="settings-pop" role="dialog" aria-label="Settings">
          <Row label="Voice AI">
            <span className="settings-tier" title={p.voiceTier?.problems.length ? `Not configured: ${p.voiceTier.problems.join(', ')}` : undefined}>
              {!p.voiceTier ? 'On-device (offline)'
                : p.voiceTier.premium_available ? `Premium · ${p.voiceTier.asr_model} + ${p.voiceTier.llm_model}`
                  : p.voiceTier.tier === 'premium' ? 'Premium (not configured) · on-device'
                    : p.voiceTier.expired ? 'Subscription expired · on-device' : 'Free · on-device'}
            </span>
          </Row>
          {p.voiceTier?.dev_tier_switch && (
            <Row label="Tier (dev)">
              <Segmented value={p.voiceTier.tier} onChange={p.onDevTier} options={[['free', 'Free'], ['premium', 'Premium']]} />
            </Row>
          )}
          <Row label="Speech language">
            <Segmented value={p.speechLang} onChange={p.onLang} options={[['en-IN', 'EN'], ['hi-IN', 'हिं']]} />
          </Row>
          <Row label="Voice replies">
            <Segmented value={p.tts ? 'on' : 'off'} onChange={(v) => p.onTts(v === 'on')} options={[['on', 'On'], ['off', 'Off']]} />
          </Row>
          {p.tts && (
            <>
              <Row label="Car voice">
                <Segmented
                  value={voicePref === 'male' ? 'male' : 'female'}
                  onChange={setVoicePref}
                  options={[['female', 'Female (Heera)'], ['male', 'Male (Ravi)']]}
                />
              </Row>
              <div className="voice-preview-row">
                <button
                  type="button"
                  className="voice-test-btn"
                  onClick={() => testVoiceSample(voicePref)}
                  title="Preview spoken Indian accent"
                >
                  <Volume2 size={13} />
                  <span>Test Voice</span>
                </button>
                <span
                  className="voice-active-label"
                  title={activeVoice ? `${activeVoice.name} (${activeVoice.lang})` : 'Default Indian voice'}
                >
                  {activeVoice
                    ? activeVoice.name.replace(/^Microsoft\s+/, '').replace(/\s+-\s+English.*$/, '').replace(/\s+Online.*$/, '')
                    : 'Indian Accent'}
                </span>
              </div>
            </>
          )}
           {p.asr && (
            <Row label="Speech recogniser">
              <Segmented value={p.asr} onChange={p.onAsr} options={[['browser', 'Web'], ['server', 'Server']]} />
            </Row>
           )}
           <hr />
           <div className="settings-heading"><Wind /><span>Wind suppression</span>{p.windSaving && <small>Saving…</small>}</div>
           {p.windSettings ? (
             <>
               <Row label="Custom filter">
                 <Segmented value={p.windSettings.enabled ? 'on' : 'off'}
                   onChange={(v) => p.onWindSettings({ enabled: v === 'on' })}
                   options={[['on', 'On'], ['off', 'Off']]} />
               </Row>
               <RangeRow label="Strength" value={p.windSettings.strength} min={0} max={1} step={0.05}
                 display={`${Math.round(p.windSettings.strength * 100)}%`}
                 onChange={(v) => p.onWindSettings({ strength: v })} />
               <RangeRow label="Max reduction" value={p.windSettings.max_attenuation_db} min={0} max={36} step={1}
                 display={`${Math.round(p.windSettings.max_attenuation_db)} dB`}
                 onChange={(v) => p.onWindSettings({ max_attenuation_db: v })} />
             </>
           ) : <p className="settings-note">Connect the server to change the custom filter.</p>}
           <Row label="Browser noise suppression">
             <Segmented value={p.browserNoiseSuppression ? 'on' : 'off'}
               onChange={(v) => p.onBrowserNoiseSuppression(v === 'on')}
               options={[['on', 'On'], ['off', 'Off']]} />
           </Row>
           <Row label="Browser auto gain">
             <Segmented value={p.autoGainControl ? 'on' : 'off'}
               onChange={(v) => p.onAutoGainControl(v === 'on')}
               options={[['on', 'On'], ['off', 'Off']]} />
           </Row>
           <p className="settings-note">The custom filter applies to Server ASR. Browser controls affect microphone capture.</p>
           <div className="wind-test">
             <div className="settings-heading"><FlaskConical /><span>Wind test</span></div>
             <p className="settings-note">Record one short command, then compare clean ASR with synthetic wind before and after suppression.</p>
             <RangeRow label="Test wind" value={p.windTestLevelDb} min={-6} max={12} step={1}
               display={`${p.windTestLevelDb > 0 ? '+' : ''}${p.windTestLevelDb} dB`}
               onChange={p.onWindTestLevelDb} />
             <button className="wind-test-button" type="button" onClick={p.onWindTest} disabled={p.windTestBusy || !p.windSettings}>
               <FlaskConical />
               {p.windTestBusy ? 'Recording / testing…' : 'Record & compare ASR'}
             </button>
             {p.windTestError && <p className="wind-test-error">{p.windTestError}</p>}
             {p.windTestResult && <WindTestResults result={p.windTestResult} />}
           </div>
           <hr />
          <button className="settings-item" onClick={p.onNextScene}><Layers /><span>Scene</span><em>{p.sceneLabel}</em></button>
          <button className="settings-item" onClick={() => p.onLog(!p.showLog)}>
            <MessageSquareText /><span>Conversation log</span><em>{p.showLog ? 'Shown' : 'with intents'}</em>
          </button>
          <button className="settings-item"
            onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())}>
            <Maximize /><span>Full screen</span>
          </button>
          <hr />
          <p className={`settings-status ${p.status.online ? 'online' : ''}`} title={p.status.detail}>{p.status.text}</p>
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="settings-row"><span>{label}</span>{children}</div>;
}

function RangeRow({ label, value, min, max, step, display, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="settings-range">
      <span>{label}</span>
      <input type="range" value={value} min={min} max={max} step={step}
        onChange={(e) => onChange(Number(e.target.value))} />
      <em>{display}</em>
    </label>
  );
}

function WindTestResults({ result }: { result: WindTestResult }) {
  const rows = [
    ['Clean recording', result.clean],
    ['Wind, filter off', result.noisy_without_suppression],
    ['Wind, filter on', result.noisy_with_suppression],
  ] as const;
  return (
    <div className="wind-test-results">
      {rows.map(([label, variant]) => (
        <div className="wind-test-result" key={label}>
          <small>{label}</small>
          <span className={variant.status === 'ok' ? '' : 'muted'}>{variant.text || variant.error || variant.status}</span>
        </div>
      ))}
    </div>
  );
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="segment" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}
