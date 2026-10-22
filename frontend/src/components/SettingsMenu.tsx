import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Layers, Maximize, MessageSquareText, Settings } from 'lucide-react';

interface Props {
  /** Connection line, e.g. "BhashaDrive NLU · English · हिन्दी · Hinglish"; `detail` goes in its tooltip. */
  status: { text: string; online: boolean; detail: string };
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
}

/** Everything the driver rarely touches, behind one button: language, voice replies, scene, log, debug. */
export function SettingsMenu(p: Props) {
  const [open, setOpen] = useState(false);
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
          <Row label="Speech language">
            <Segmented value={p.speechLang} onChange={p.onLang} options={[['en-IN', 'EN'], ['hi-IN', 'हिं']]} />
          </Row>
          <Row label="Voice replies">
            <Segmented value={p.tts ? 'on' : 'off'} onChange={(v) => p.onTts(v === 'on')} options={[['on', 'On'], ['off', 'Off']]} />
          </Row>
          {p.asr && (
            <Row label="Speech recogniser">
              <Segmented value={p.asr} onChange={p.onAsr} options={[['browser', 'Web'], ['server', 'Server']]} />
            </Row>
          )}
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

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="segment" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}
