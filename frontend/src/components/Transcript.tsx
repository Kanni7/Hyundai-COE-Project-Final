import { useEffect, useRef } from 'react';
import { Mic, MousePointerClick, Keyboard, Trash2, X } from 'lucide-react';
import type { ChatMessage } from '../types';
import { describeIntent } from '../lib/intents';

const VIA = { voice: Mic, text: Keyboard, chip: MousePointerClick };
const ENGINE_LABEL = { backend: 'BhashaDrive', local: 'local parser', llm: 'command LLM' } as const;

export function Transcript({ messages, onClose, onClear }: { messages: ChatMessage[]; onClose: () => void; onClear: () => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  return (
    <aside className="transcript">
      <header>
        <div>
          <b>Conversation</b>
          <small>Text → intent → car action</small>
        </div>
        <button onClick={onClear} title="Clear" aria-label="Clear conversation"><Trash2 /></button>
        <button onClick={onClose} title="Hide" aria-label="Hide conversation"><X /></button>
      </header>
      <div className="msgs">
        {messages.map((m) => {
          const Via = m.via ? VIA[m.via] : null;
          return (
            <div key={m.id} className={`msg ${m.role}`}>
              <p>{Via && <Via />}{m.text}</p>
              {((m.intents && m.intents.length > 0) || m.engine) && (
                <div className="intents">
                  {m.engine && <code className={`engine ${m.engine}`}>{ENGINE_LABEL[m.engine]}</code>}
                  {m.intents?.map((i, k) => <code key={k}>{describeIntent(i)}</code>)}
                </div>
              )}
            </div>
          );
        })}
        <div ref={end} />
      </div>
    </aside>
  );
}
