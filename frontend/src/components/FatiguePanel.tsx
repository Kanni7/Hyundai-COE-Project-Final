// Driver Monitor tabs for the fatigue response: the event timeline (what fired and why)
// and the presenter controls (simulate the driver, jump to a level, fake the context).

import { CameraOff, Eye, EyeClosed, Moon, Power, Route, Timer, Trash2, Video, Zap } from 'lucide-react';
import type { CarState } from '../types';
import { LIMITS, clock, contextRisk } from '../lib/fatigue';
import { RISK_LABEL, type FatigueGuard, type SimDriver } from '../lib/useFatigueGuard';

const SIM: { id: SimDriver; label: string; Icon: typeof Eye }[] = [
  { id: 'camera', label: 'Camera', Icon: Video },
  { id: 'alert', label: 'Alert', Icon: Eye },
  { id: 'tired', label: 'Tired', Icon: Timer },
  { id: 'eyes-closed', label: 'Eyes closed', Icon: EyeClosed },
  { id: 'blocked', label: 'Blocked', Icon: CameraOff },
];

export function FatigueTimeline({ guard }: { guard: FatigueGuard }) {
  const { timeline } = guard;
  return (
    <div className="fg-timeline">
      <div className="fg-tl-head">
        <span>{timeline.length ? `${timeline.length} events, newest first` : 'Nothing yet: events appear here as the car responds.'}</span>
        {timeline.length > 0 && <button onClick={guard.presenter.clearTimeline} title="Clear timeline"><Trash2 /></button>}
      </div>
      <ol>
        {timeline.map((e) => (
          <li key={e.id} className={`tone-${e.tone}`}>
            <time>{e.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
            <b>{e.title}</b>
            {e.detail && <span>{e.detail}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function FatiguePresenter({ guard, car, onStartEngine }: { guard: FatigueGuard; car: CarState; onStartEngine: () => void }) {
  const p = guard.presenter;
  const engineOn = car.ignition === 'on';
  const risk = contextRisk(p.simNight, p.simLongTrip ? 135 : 0);
  const l = LIMITS[risk];
  return (
    <div className="fg-presenter">
      {!engineOn && (
        <button className="fg-engine" onClick={onStartEngine}><Power /> Start the engine: the response only runs while driving</button>
      )}

      <h4>Driver (simulated)</h4>
      <div className="fg-seg" role="radiogroup" aria-label="Simulated driver">
        {SIM.map(({ id, label, Icon }) => (
          <button key={id} role="radio" aria-checked={p.sim === id} className={p.sim === id ? 'on' : ''} onClick={() => p.setSim(id)}>
            <Icon /><span>{label}</span>
          </button>
        ))}
      </div>
      <p className="fg-hint">
        {p.sim === 'camera' ? 'Using the real camera.'
          : p.sim === 'tired' ? `Level 1 now, Level 2 after ${clock(l.l2WaitS)} of tiredness.`
            : p.sim === 'eyes-closed' ? `Level 2 at 2 s, Level 3 at ${l.l3ClosedS} s of closed eyes.`
              : p.sim === 'blocked' ? 'Covered lens: monitoring pauses, nothing escalates.'
                : 'Driver awake: an episode ends after 0:30 of alertness.'}
      </p>

      <h4>Jump to level</h4>
      <div className="fg-levels">
        <button className="l1" disabled={!engineOn} onClick={() => p.force(1)}><Zap /> Level 1</button>
        <button className="l2" disabled={!engineOn} onClick={() => p.force(2)}><Zap /> Level 2</button>
        <button className="l3" disabled={!engineOn} onClick={() => p.force(3)}><Zap /> Level 3</button>
        <button className="reset" onClick={p.reset}>Reset</button>
      </div>

      <h4>Context</h4>
      <div className="fg-toggles">
        <label><input type="checkbox" checked={p.simNight} onChange={(e) => p.setSimNight(e.target.checked)} /><Moon /> Night drive (2:30 AM)</label>
        <label><input type="checkbox" checked={p.simLongTrip} onChange={(e) => p.setSimLongTrip(e.target.checked)} /><Route /> Long trip (2 h 15 m)</label>
        <label><input type="checkbox" checked={p.demoTiming} onChange={(e) => p.setDemoTiming(e.target.checked)} /><Timer /> Demo timing (waits run ×6)</label>
      </div>
      <p className="fg-hint">Risk <b>{RISK_LABEL[risk]}</b>: Level 2 after {clock(l.l2WaitS)}, Level 3 at {l.l3ClosedS} s closed eyes. Context never triggers a level on its own.</p>
    </div>
  );
}
