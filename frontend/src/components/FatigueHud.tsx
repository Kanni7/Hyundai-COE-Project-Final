// On-screen view of MYRA's fatigue response: what level the car is at, why, and each
// cabin action as it happens. Built for the demo: everything the car does is visible.

import { useEffect, useState } from 'react';
import {
  CameraOff, Check, CircleCheck, Fan, Lightbulb, LoaderCircle, MessageCircle, Navigation, RotateCcw, ShieldCheck,
  Siren, Thermometer, TriangleAlert, Wind, Leaf,
} from 'lucide-react';
import type { CarState } from '../types';
import { clock } from '../lib/fatigue';
import { RISK_LABEL, describeContext, type ActionIcon, type FatigueGuard } from '../lib/useFatigueGuard';

const ICON: Record<ActionIcon, typeof Fan> = {
  temp: Thermometer, fan: Fan, vent: Wind, light: Lightbulb, air: Leaf, voice: MessageCircle,
  hazard: TriangleAlert, alarm: Siren, nav: Navigation, restore: RotateCcw,
};
const TITLE = { 1: 'Cabin wake-up', 2: 'MYRA check-in', 3: 'Emergency' } as const;

/** Re-render a few times a second for countdowns read from the live controller. */
function useTick(active: boolean, ms = 200) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setN((n) => n + 1), ms);
    return () => window.clearInterval(t);
  }, [active, ms]);
}

/** Top view of the car with all four indicators flashing. */
function HazardCar() {
  return (
    <div className="fg-car" aria-label="Hazard lights flashing">
      <img src={`${import.meta.env.BASE_URL}images/verna-top.webp`} alt="" draggable={false} />
      <i className="fl" /><i className="fr" /><i className="rl" /><i className="rr" />
    </div>
  );
}

export function FatigueHud({ guard, car, monitorOn }: { guard: FatigueGuard; car: CarState; monitorOn: boolean }) {
  const { level, why, actions, flash, presenter } = guard;
  useTick(monitorOn);
  const live = guard.getLive();
  const snap = live.snap;
  const blocked = monitorOn && live.signal === 'blocked';
  const engineOn = car.ignition === 'on';
  const context = `${RISK_LABEL[snap.risk]} · ${describeContext(live.night, live.drivingMin, presenter.simNight)}`;

  let card = null;
  if (level > 0) {
    const l = snap.limits;
    const snoozed = snap.snoozeLeftS > 0;
    card = (
      <section className={`fg-card lvl-${level}`} role={level === 3 ? 'alert' : 'status'} aria-live="assertive">
        <header>
          <span className="fg-badge">Level {level}</span>
          <b>{TITLE[level as 1 | 2 | 3]}</b>
          <span className={`fg-ctx risk-${snap.risk}`} title="Context risk: time of day and trip length">{context}</span>
        </header>
        {level === 3 ? (
          <div className="fg-emergency-body">
            <HazardCar />
            <div>
              <strong>STOP SAFELY</strong>
              <p>{why}</p>
              <p className="fg-sub">Hazard lights on · alarm sounding</p>
            </div>
          </div>
        ) : (
          <p className="fg-why">{why}</p>
        )}

        {level === 1 && (
          snoozed ? (
            <div className="fg-progress snoozed"><span>Check-in snoozed by driver · {clock(snap.snoozeLeftS)} left</span></div>
          ) : (
            <div className="fg-progress">
              <span>Tired for <b>{clock(snap.tiredS)}</b> / {clock(l.l2WaitS)} → Level 2</span>
              <div className="fg-bar"><i style={{ width: `${Math.min(100, (snap.tiredS / l.l2WaitS) * 100)}%` }} /></div>
            </div>
          )
        )}

        {level === 2 && (snap.question === 'pending' || snap.question === 'unanswered') && (
          <div className="fg-question">
            <p>“Thak gaye? Paas mein dhaba hai, rukein?”</p>
            <div>
              <button onClick={() => guard.answer(true)}>Haan, rukte hain</button>
              <button onClick={() => guard.answer(false)}>Nahi, theek hoon</button>
            </div>
            {snap.question === 'unanswered' && <small>No answer yet: cabin measures stay on</small>}
          </div>
        )}

        <ul className="fg-actions">
          {actions.map((a) => {
            const Icon = ICON[a.icon];
            return (
              <li key={a.id} className={a.done ? 'done' : 'busy'}>
                <Icon className="ic" /><span>{a.text}</span>
                {a.done ? <Check className="st" /> : <LoaderCircle className="st spin" />}
              </li>
            );
          })}
        </ul>
        <footer>Level 3 if eyes stay closed {l.l3ClosedS} s</footer>
      </section>
    );
  } else if (flash === 'recovered') {
    card = (
      <section className="fg-card ok" role="status">
        <header><CircleCheck className="fg-ok" /><b>Driver alert again</b></header>
        <ul className="fg-actions">
          {actions.map((a) => <li key={a.id} className="done"><RotateCcw className="ic" /><span>{a.text}</span><Check className="st" /></li>)}
        </ul>
      </section>
    );
  } else if (blocked) {
    card = (
      <section className="fg-card blocked" role="status">
        <header><CameraOff className="fg-ok" /><b>Camera blocked</b><span className="fg-ctx">{Math.floor(snap.blockedS)} s</span></header>
        <p className="fg-why">Drowsiness monitoring is paused. A covered camera is <b>not</b> treated as drowsiness, and nothing escalates.</p>
      </section>
    );
  } else if (monitorOn) {
    card = (
      <div className="fg-pill">
        <ShieldCheck />
        {engineOn
          ? <span>Fatigue Guard armed · Context {context}</span>
          : <span>Fatigue Guard standing by · start the engine</span>}
      </div>
    );
  }

  return (
    <>
      {level === 3 && <div className="fg-emergency" aria-hidden />}
      {car.hazard && (
        <div className="fg-hazard" aria-hidden>
          <i className="left" /><i className="right" />
        </div>
      )}
      {card && <div className="fg-wrap">{card}</div>}
    </>
  );
}
