// MYRA's fatigue response, wired to the car: reads the driver monitor (or the presenter's
// simulated driver), runs the escalation logic in lib/fatigue.ts and carries out each level
// on the cabin: AC, blower, vents, ambient light, fresh air, voice, navigation and hazards.
// Everything the car does is also listed on screen (HUD, spotlights and the timeline).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CarState } from '../types';
import { TEMP_MIN } from '../state/car';
import type { DriverStatus } from './drowsiness';
import {
  DEMO_TIME_SCALE,
  FatigueController,
  LIMITS,
  clock,
  isNight,
  parseYesNo,
  type ContextRisk,
  type DriverSignal,
  type FatigueEvent,
  type FatigueInput,
  type FatigueLevel,
  type FatigueSnapshot,
} from './fatigue';
import { carAudio } from './audio';
import { AIM_AT_DRIVER, animateVents, ventAims, ventsTouchedAt, type VentAim } from './ventAim';

/** What the presenter makes the "driver" do; 'camera' uses the real driver monitor. */
export type SimDriver = 'camera' | 'alert' | 'tired' | 'eyes-closed' | 'blocked';

export type ActionIcon = 'temp' | 'fan' | 'vent' | 'light' | 'air' | 'voice' | 'hazard' | 'alarm' | 'nav' | 'restore';
export interface ActionLine { id: string; icon: ActionIcon; text: string; done: boolean }

export type TimelineTone = 'l1' | 'l2' | 'l3' | 'ok' | 'info' | 'warn';
export interface TimelineEntry { id: number; at: Date; tone: TimelineTone; title: string; detail?: string }

/** A ring drawn on the cabin (drawing coordinates) around a part the car just changed. */
export interface Spotlight { id: string; rect: [number, number, number, number]; label: string; tone: 'cool' | 'danger'; below?: boolean }

export interface LiveGuard {
  snap: FatigueSnapshot;
  signal: DriverSignal;
  /** Context factors as currently applied (real or presenter-simulated). */
  night: boolean;
  drivingMin: number;
}

interface Deps {
  carRef: { current: CarState };
  commit: (s: CarState) => void;
  /** MYRA speaks (and shows) a line; `confirm` opens the mic for a yes/no answer. */
  say: (text: string, opts?: { confirm?: boolean }) => void;
  startNav: (destination: string) => void;
  monitorOn: boolean;
}

/** Cabin parts in the drawn cockpit, in drawing pixels. */
const RECT = {
  vents: [950, 420, 392, 80] as [number, number, number, number],
  climate: [980, 498, 332, 74] as [number, number, number, number],
  hazard: [1118, 440, 56, 41] as [number, number, number, number],
};
const SIM_REASON = 'Slow, heavy blinking (simulated)';
const LONG_TRIP_SIM_MIN = 135;
const NIGHT_SIM_LABEL = '2:30 AM';
const L1_FAN = 5;
const EMERGENCY_REPEAT_MS = 8000;
const SPOTLIGHT_MS = 9000;
const L2_QUESTION = 'Thak gaye? Paas mein dhaba hai, rukein?';
const DHABA = 'Nearest dhaba';
const LEVEL_NAME: Record<FatigueLevel, string> = { 0: 'Monitoring', 1: 'Cabin wake-up', 2: 'MYRA check-in', 3: 'Emergency' };
export const RISK_LABEL: Record<ContextRisk, string> = { normal: 'Normal', elevated: 'Elevated', high: 'High' };

interface Saved { climate: CarState['climate']; ambient: CarState['ambient']; aims: VentAim[]; since?: number }
interface Applied { temp?: number; fan?: number; recirc?: boolean; ambient?: CarState['ambient']; aims?: VentAim[]; hazard?: boolean }

let entryId = 1;
const IDLE = new FatigueController().snapshot();
const round1 = (v: number) => Math.round(v * 10) / 10;
const sameAmbient = (a: CarState['ambient'], b: CarState['ambient']) =>
  a.on === b.on && a.color === b.color && a.hue === b.hue && a.mode === b.mode && a.brightness === b.brightness;
const COOL_AMBIENT = (a: CarState['ambient']): CarState['ambient'] => ({ ...a, on: true, color: 'cyan', hue: null, mode: 'static', brightness: 1 });
const ALARM_AMBIENT = (a: CarState['ambient']): CarState['ambient'] => ({ ...a, on: true, color: 'red', hue: null, mode: 'breathe', brightness: 1 });

export function describeContext(night: boolean, drivingMin: number, simNight: boolean) {
  const parts: string[] = [];
  if (night) parts.push(simNight ? `Night drive (${NIGHT_SIM_LABEL})` : 'Night drive');
  if (drivingMin >= 120) parts.push(`${Math.floor(drivingMin / 60)} h ${drivingMin % 60} m driving`);
  return parts.length ? parts.join(' · ') : 'Daytime, short trip';
}

export function useFatigueGuard({ carRef, commit, say, startNav, monitorOn }: Deps) {
  const ctrl = useRef(new FatigueController());
  const [level, setLevel] = useState<FatigueLevel>(0);
  const [why, setWhy] = useState('');
  const [actions, setActions] = useState<ActionLine[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [spotlights, setSpotlights] = useState<Spotlight[]>([]);
  const [flash, setFlash] = useState<'recovered' | null>(null);
  const [sim, setSimState] = useState<SimDriver>('camera');
  const [simNight, setSimNight] = useState(false);
  const [simLongTrip, setSimLongTrip] = useState(false);
  const [demoTiming, setDemoTiming] = useState(true);

  const levelRef = useRef<FatigueLevel>(0);
  const reading = useRef<{ st: DriverStatus; blocked: boolean; at: number } | null>(null);
  const simRef = useRef<{ mode: SimDriver; closedAt: number }>({ mode: 'camera', closedAt: 0 });
  const ctxRef = useRef({ simNight, simLongTrip });
  const live = useRef<LiveGuard>({ snap: IDLE, signal: 'off', night: false, drivingMin: 0 });
  const engineOnAt = useRef<number | null>(null);
  const saved = useRef<Saved | null>(null);
  const applied = useRef<Applied>({});
  const timers = useRef<number[]>([]);
  const spotTimers = useRef<Map<string, number>>(new Map());
  const emergencyLoop = useRef<number | undefined>(undefined);
  const flashTimer = useRef<number | undefined>(undefined);
  const deps = useRef({ say, startNav, commit });
  useEffect(() => { deps.current = { say, startNav, commit }; }, [say, startNav, commit]);
  useEffect(() => { ctxRef.current = { simNight, simLongTrip }; }, [simNight, simLongTrip]);
  useEffect(() => { ctrl.current.timeScale = demoTiming ? DEMO_TIME_SCALE : 1; }, [demoTiming]);

  const patch = useCallback((fn: (s: CarState) => CarState) => deps.current.commit(fn(carRef.current)), [carRef]);

  const log = useCallback((tone: TimelineTone, title: string, detail?: string) => {
    setTimeline((t) => [{ id: entryId++, at: new Date(), tone, title, detail }, ...t].slice(0, 60));
  }, []);

  // The cabin actions only touch refs and state setters, so they are built once.
  const { handle, stopEmergency, clearTimers } = useMemo(() => {
    const car = () => carRef.current;
    const later = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, ms)); };
    const clearTimers = () => { timers.current.forEach((t) => window.clearTimeout(t)); timers.current = []; };

    const upsertAction = (line: ActionLine) => setActions((list) => {
      const i = list.findIndex((a) => a.id === line.id);
      return i < 0 ? [...list, line] : list.map((a, k) => (k === i ? line : a));
    });

    const spotlight = (s: Spotlight, ms = SPOTLIGHT_MS) => {
      setSpotlights((list) => [...list.filter((x) => x.id !== s.id), s]);
      window.clearTimeout(spotTimers.current.get(s.id));
      if (ms > 0) spotTimers.current.set(s.id, window.setTimeout(() => setSpotlights((list) => list.filter((x) => x.id !== s.id)), ms));
    };
    const clearSpotlights = () => {
      spotTimers.current.forEach((t) => window.clearTimeout(t));
      spotTimers.current.clear();
      setSpotlights([]);
    };

    /** Level 1: cool the cabin step by step, so each change can be seen as it happens. */
    const cabinWakeUp = () => {
      const s0 = car();
      saved.current = { climate: { ...s0.climate }, ambient: { ...s0.ambient }, aims: ventAims.map((a) => ({ ...a })), since: performance.now() };
      applied.current = {};
      setActions([]);

      // AC down 1.5 °C in half-degree steps
      const from = s0.climate.temp;
      const to = Math.max(TEMP_MIN, round1(from - 1.5));
      const steps = Math.max(1, Math.ceil((from - to) / 0.5 - 1e-6));
      upsertAction({ id: 'temp', icon: 'temp', text: `AC ${from.toFixed(1)} → ${to.toFixed(1)} °C`, done: false });
      spotlight({ id: 'climate', rect: RECT.climate, label: `AC ${to.toFixed(1)} °C ▼  ·  fresh air`, tone: 'cool', below: true });
      for (let k = 1; k <= steps; k++) {
        const v = k === steps ? to : round1(Math.max(to, from - 0.5 * k));
        later(250 + k * 380, () => patch((s) => ({ ...s, climate: { ...s.climate, on: true, auto: false, temp: v } })));
      }
      const tempDone = 250 + steps * 380;
      later(tempDone, () => {
        applied.current.temp = to;
        upsertAction({ id: 'temp', icon: 'temp', text: from === to ? `AC already at minimum ${to.toFixed(1)} °C` : `AC ${from.toFixed(1)} → ${to.toFixed(1)} °C`, done: true });
      });

      // Blower up so the air reaches the driver
      later(tempDone + 400, () => {
        const fan = Math.max(car().climate.fan, L1_FAN);
        const before = car().climate.fan;
        patch((s) => ({ ...s, climate: { ...s.climate, on: true, fan } }));
        applied.current.fan = fan;
        upsertAction({ id: 'fan', icon: 'fan', text: before === fan ? `Blower at ${fan} / 8` : `Blower ${before} → ${fan} / 8`, done: true });
      });

      // Vents swing to the driver's face
      later(tempDone + 900, () => {
        upsertAction({ id: 'vent', icon: 'vent', text: 'Vents swinging towards the driver', done: false });
        // In an emergency the hazard switch (between the vents) has the spotlight.
        if (levelRef.current < 3) spotlight({ id: 'vents', rect: RECT.vents, label: 'Air → driver', tone: 'cool' });
        applied.current.aims = AIM_AT_DRIVER.map((a) => ({ ...a }));
        animateVents(AIM_AT_DRIVER, 1400);
        later(1450, () => {
          upsertAction({ id: 'vent', icon: 'vent', text: 'Vents aimed at the driver', done: true });
        });
      });

      // Cool, alerting light (an emergency already in progress keeps its red)
      later(tempDone + 2500, () => {
        if (levelRef.current >= 3) return;
        const ambient = COOL_AMBIENT(car().ambient);
        patch((s) => ({ ...s, ambient }));
        applied.current.ambient = ambient;
        upsertAction({ id: 'light', icon: 'light', text: 'Ambient light → cool cyan', done: true });
      });

      // Fresh outside air: stale, CO₂-heavy cabin air adds to drowsiness
      later(tempDone + 3100, () => {
        const wasRecirc = car().climate.recirc;
        patch((s) => ({ ...s, climate: { ...s.climate, recirc: false } }));
        applied.current.recirc = false;
        upsertAction({ id: 'air', icon: 'air', text: wasRecirc ? 'Fresh air on (recirculation off)' : 'Fresh air already on', done: true });
      });
    };

    const stopEmergency = () => {
      carAudio.alarm(false);
      window.clearInterval(emergencyLoop.current);
      emergencyLoop.current = undefined;
    };

    /** Level 3: alarm, red pulsing light, hazards, and a repeated spoken instruction. */
    const emergency = () => {
      carAudio.alarm(true);
      const s = car();
      const ambient = ALARM_AMBIENT(s.ambient);
      if (!s.hazard) applied.current.hazard = true;
      patch((x) => ({ ...x, hazard: true, ambient }));
      applied.current.ambient = ambient;
      upsertAction({ id: 'alarm', icon: 'alarm', text: 'Urgent alarm sounding', done: true });
      upsertAction({ id: 'hazard', icon: 'hazard', text: 'Hazard lights ON (simulation)', done: true });
      upsertAction({ id: 'light', icon: 'light', text: 'Ambient light → pulsing red', done: true });
      spotlight({ id: 'hazard', rect: RECT.hazard, label: 'Hazards ON', tone: 'danger' }, 0);
      setSpotlights((list) => list.filter((x) => x.id !== 'vents'));
      const warn = () => deps.current.say('Please stop the car safely. Hazard lights are on.');
      warn();
      window.clearInterval(emergencyLoop.current);
      emergencyLoop.current = window.setInterval(warn, EMERGENCY_REPEAT_MS);
    };

    /** Puts back what the car changed, unless the driver has changed it since. */
    const restore = () => {
      const before = saved.current;
      const a = applied.current;
      const s = car();
      const done: string[] = [];
      if (before) {
        let climate = s.climate;
        if (a.temp !== undefined && Math.abs(s.climate.temp - a.temp) < 0.05) { climate = { ...climate, temp: before.climate.temp }; done.push(`AC back to ${before.climate.temp.toFixed(1)} °C`); }
        if (a.fan !== undefined && s.climate.fan === a.fan) { climate = { ...climate, fan: before.climate.fan }; done.push(`blower ${before.climate.fan}`); }
        if (a.recirc !== undefined && s.climate.recirc === a.recirc && before.climate.recirc) { climate = { ...climate, recirc: true }; done.push('recirculation on'); }
        if (!before.climate.on && climate !== s.climate) climate = { ...climate, on: false, auto: before.climate.auto };
        let ambient = s.ambient;
        if (a.ambient && sameAmbient(s.ambient, a.ambient)) { ambient = before.ambient; done.push('ambient light'); }
        const hazard = a.hazard && s.hazard ? false : s.hazard;
        if (hazard !== s.hazard) done.push('hazards off');
        deps.current.commit({ ...s, climate, ambient, hazard });
        // Vents go back unless the driver has aimed them by hand since the episode began.
      if (a.aims && ventsTouchedAt() < (before.since ?? 0)) { animateVents(before.aims, 1200); done.push('vents'); }
      }
      saved.current = null;
      applied.current = {};
      return done;
    };

    const handle = (events: FatigueEvent[]) => {
      for (const e of events) {
        switch (e.kind) {
          case 'context': {
            const l = LIMITS[e.risk];
            log('info', `Context risk: ${RISK_LABEL[e.risk]}`,
              e.risk === 'normal' ? 'Standard timing' : `Faster escalation: Level 2 after ${clock(l.l2WaitS)}, Level 3 at ${l.l3ClosedS} s of closed eyes`);
            break;
          }
          case 'level': {
            const from = e.from;
            levelRef.current = e.level;
            setLevel(e.level);
            setWhy(e.why);
            setFlash(null);
            const tone = (`l${e.level}` as TimelineTone);
            if (e.level < from) log(e.level === 1 ? 'l1' : 'l2', `Level ${from} → Level ${e.level}`, e.why);
            else log(tone, `Level ${e.level} · ${LEVEL_NAME[e.level]}`, e.why);
            if (from === 0) cabinWakeUp();
            if (e.level === 3) emergency();
            if (from === 3 && e.level < 3) {
              stopEmergency();
              const ambient = COOL_AMBIENT(car().ambient);
              patch((s) => ({ ...s, ambient }));
              applied.current.ambient = ambient;
              setActions((l) => l.filter((x) => x.id !== 'alarm').map((x) => (x.id === 'light' ? { ...x, text: 'Ambient light → cool cyan' } : x)));
              setSpotlights((l) => l.filter((x) => x.id !== 'hazard'));
              deps.current.say('Thank you. Please pull over at a safe place and take a break. Hazard lights stay on.');
            }
            break;
          }
          case 'ask':
            upsertAction({ id: 'voice', icon: 'voice', text: `MYRA: “${L2_QUESTION}”`, done: true });
            log('l2', 'MYRA asked the driver', `“${L2_QUESTION}”`);
            deps.current.say(L2_QUESTION, { confirm: true });
            break;
          case 'answer':
            if (e.yes) {
              upsertAction({ id: 'nav', icon: 'nav', text: 'Navigating to the nearest dhaba', done: true });
              log('ok', 'Driver agreed to stop', 'Navigation started to the nearest dhaba');
              deps.current.say('Theek hai! Paas ke dhabe ka raasta shuru kar rahi hoon.');
              deps.current.startNav(DHABA);
            } else {
              upsertAction({ id: 'nav', icon: 'voice', text: 'Driver declined: check-in snoozed for 10:00', done: true });
              log('info', 'Driver declined a break', 'MYRA will not ask again for 10:00. Level 3 can still fire.');
              deps.current.say('Theek hai. Main das minute tak nahi poochungi. Dhyaan se chalaiye.');
            }
            break;
          case 'no-answer':
            log('warn', 'No answer from the driver', 'Cabin measures stay on');
            break;
          case 'recovered': {
            stopEmergency();
            clearTimers();
            const done = restore();
            levelRef.current = 0;
            setLevel(0);
            setActions(done.length ? [{ id: 'restore', icon: 'restore', text: `Restored: ${done.join(', ')}`, done: true }] : []);
            clearSpotlights();
            setFlash('recovered');
            window.clearTimeout(flashTimer.current);
            flashTimer.current = window.setTimeout(() => setFlash(null), 6000);
            log('ok', 'Driver alert again', done.length ? `Cabin restored: ${done.join(', ')}` : 'Episode ended');
            break;
          }
          case 'blocked':
            log('warn', 'Camera blocked', 'Drowsiness monitoring paused. This is not treated as drowsiness.');
            deps.current.say('The driver camera is blocked. Drowsiness monitoring is paused until it is clear.');
            break;
          case 'unblocked':
            log('ok', 'Camera clear', 'Monitoring resumed');
            break;
        }
      }
    };
    return { handle, stopEmergency, clearTimers };
  }, [carRef, log, patch]);

  // Monitoring loop: 10 readings a second while the driver monitor is on.
  useEffect(() => {
    if (!monitorOn) return;
    const c = ctrl.current;
    const tick = () => {
      const now = performance.now();
      const car = carRef.current;
      if (car.ignition === 'on') engineOnAt.current ??= now;
      else engineOnAt.current = null;
      const { simNight: sn, simLongTrip: sl } = ctxRef.current;
      const night = sn || isNight(new Date().getHours());
      const realMin = engineOnAt.current === null ? 0 : Math.floor((now - engineOnAt.current) / 60000);
      const drivingMin = sl ? LONG_TRIP_SIM_MIN : realMin;
      const base = { night, drivingMin };
      let input: FatigueInput;
      const sm = simRef.current;
      if (car.ignition !== 'on') {
        input = { ...base, signal: 'off', closedS: 0, reason: '' };
      } else if (sm.mode === 'alert') {
        input = { ...base, signal: 'alert', closedS: 0, reason: 'Eyes open, attentive (simulated)' };
      } else if (sm.mode === 'tired') {
        input = { ...base, signal: 'tired', closedS: 0, reason: SIM_REASON };
      } else if (sm.mode === 'eyes-closed') {
        const closedS = (now - sm.closedAt) / 1000;
        input = { ...base, signal: closedS >= 2 ? 'drowsy' : 'alert', closedS, reason: `Eyes closed for ${closedS.toFixed(1)} s (simulated)` };
      } else if (sm.mode === 'blocked') {
        input = { ...base, signal: 'blocked', closedS: 0, reason: 'Camera blocked (simulated)' };
      } else {
        const r = reading.current;
        const fresh = r && now - r.at < 1500;
        const st = fresh ? r.st : null;
        const signal: DriverSignal = !st ? 'unavailable'
          : r!.blocked ? 'blocked'
            : st.state === 'alert' || st.state === 'tired' || st.state === 'drowsy' ? st.state : 'unavailable';
        input = { ...base, signal, closedS: st?.closedS ?? 0, reason: st?.reason ?? '' };
      }
      handle(c.update(now, input));
      live.current = { snap: c.snapshot(), signal: input.signal, night, drivingMin };
    };
    tick();
    const t = window.setInterval(tick, 100);
    return () => {
      window.clearInterval(t);
      handle(c.reset());
      live.current = { snap: c.snapshot(), signal: 'off', night: false, drivingMin: 0 };
    };
  }, [monitorOn, carRef, handle]);

  // Leave nothing running if the app goes away mid-episode.
  useEffect(() => () => { stopEmergency(); clearTimers(); }, [stopEmergency, clearTimers]);

  const onMonitorStatus = useCallback((st: DriverStatus, blocked: boolean) => {
    reading.current = { st, blocked, at: performance.now() };
  }, []);

  const setSim = useCallback((mode: SimDriver) => {
    simRef.current = { mode, closedAt: performance.now() };
    setSimState(mode);
  }, []);

  /** Presenter: jump to a level, with the simulated driver set to match so it holds. */
  const force = useCallback((lvl: 1 | 2 | 3) => {
    if (carRef.current.ignition !== 'on') return;
    carAudio.unlock();
    const now = performance.now();
    if (lvl === 3) {
      simRef.current = { mode: 'eyes-closed', closedAt: now - 6000 };
      setSimState('eyes-closed');
    } else {
      simRef.current = { mode: 'tired', closedAt: now };
      setSimState('tired');
    }
    handle(ctrl.current.force(lvl, now));
  }, [carRef, handle]);

  const reset = useCallback(() => {
    if (simRef.current.mode === 'tired' || simRef.current.mode === 'eyes-closed') {
      simRef.current = { mode: 'alert', closedAt: 0 };
      setSimState('alert');
    }
    handle(ctrl.current.reset());
  }, [handle]);

  /** The driver's spoken/typed/tapped reply to the Level 2 question; true when it was one. */
  const tryAnswer = useCallback((text: string) => {
    const q = ctrl.current.snapshot().question;
    if (q !== 'pending' && q !== 'unanswered') return false;
    const yes = parseYesNo(text);
    if (yes === null) return false;
    handle(ctrl.current.answer(yes, performance.now()));
    return true;
  }, [handle]);

  const answer = useCallback((yes: boolean) => { handle(ctrl.current.answer(yes, performance.now())); }, [handle]);

  return {
    level, why, actions, timeline, spotlights, flash,
    getLive: () => live.current,
    onMonitorStatus, tryAnswer, answer,
    presenter: {
      sim, setSim, simNight, setSimNight, simLongTrip, setSimLongTrip, demoTiming, setDemoTiming, force, reset,
      clearTimeline: () => setTimeline([]),
    },
  };
}

export type FatigueGuard = ReturnType<typeof useFatigueGuard>;
