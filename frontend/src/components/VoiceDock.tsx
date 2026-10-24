import { useRef, useState, type FormEvent } from 'react';
import { Mic, Send, Square } from 'lucide-react';
import type { VoicePhase } from './Infotainment';

interface Props {
  phase: VoicePhase;
  /** Live words from the browser recogniser while listening (the server recogniser has none). */
  interim: string;
  /** The last command as the car understood it: the transcript after rescoring, or the typed text. */
  heard: { text: string; via: 'voice' | 'text' | 'chip' } | null;
  /** `asks`: the reply is a question, so the mic reopens for the answer. */
  reply: { text: string; understood: boolean; asks: boolean } | null;
  suggestions: string[];
  supported: boolean;
  error: string | null;
  onMic: () => void;
  onSend: (text: string, via: 'text' | 'chip') => void;
}

const HEARD_LABEL = { voice: 'You said', text: 'You typed', chip: 'You chose' } as const;

export function VoiceDock({ phase, interim, heard, reply, suggestions, supported, error, onMic, onSend }: Props) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    onSend(text.trim(), 'text');
    setText('');
  };
  const listening = phase === 'listening';
  const answering = listening && !!reply?.asks;

  const status = listening ? (answering ? 'Listening for your answer…' : 'Listening…')
    : phase === 'transcribing' ? 'Transcribing…'
    : phase === 'thinking' ? 'Understanding…'
      : phase === 'speaking' ? 'Speaking'
        : error ?? (supported ? 'Tap the mic or press Space to talk' : 'Type a command below');
  // While listening the old exchange gives way to the live words (keeping a question being answered);
  // while thinking only the new command shows.
  const heardLine = listening ? (interim ? { text: interim, via: 'voice' as const } : null) : heard;
  const replyLine = phase === 'thinking' || phase === 'transcribing' || (listening && !answering) ? null : reply;

  return (
    <div className="dock">
      <section className={`voice ${phase} ${error && phase === 'idle' ? 'error' : ''} ${replyLine && !replyLine.understood ? 'miss' : ''}`}
        aria-live="polite">
        <div className="voice-status">
          <span className="wave" aria-hidden="true"><i /><i /><i /><i /><i /></span>
          <b>{status}</b>
          {listening && !interim && <small>English, हिन्दी or Hinglish</small>}
        </div>
        {heardLine && (
          <p className="voice-heard"><small>{HEARD_LABEL[heardLine.via]}</small><span>“{heardLine.text}”</span></p>
        )}
        {replyLine && <p className="voice-reply" key={replyLine.text}>{replyLine.text}</p>}
      </section>

      <div className="suggest" role="list" aria-label="Suggestions">
        {suggestions.map((s) => (
          <button key={s} role="listitem" onClick={() => onSend(s, 'chip')}>{s}</button>
        ))}
      </div>

      <form className="bar" onSubmit={submit}>
        <button type="button" className={`mic ${listening ? 'live' : ''} ${phase}`} onClick={onMic} disabled={!supported}
          title={supported ? 'Speak (Space)' : 'Voice input needs Chrome or Edge. Type instead.'} aria-label="Speak">
          {listening ? <Square /> : <Mic />}
          {listening && <><i /><i /></>}
        </button>
        <input ref={input} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={supported ? 'Bolo ya likho… "AC 20 pe kar do"' : 'Type a command… "AC 20 pe kar do"'} aria-label="Command" />
        <button type="submit" className="send" aria-label="Send" disabled={!text.trim()}><Send /></button>
      </form>
    </div>
  );
}
