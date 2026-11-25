// Fatigue response: decides how strongly the cabin reacts to the driver's condition.
// Pure logic, no React or browser APIs, so it can be unit tested. The camera side
// (lib/drowsiness.ts) says *what* it sees; this module decides *what the car does*.
//
// Level 1  cabin wake-up    driver looks tired
// Level 2  MYRA check-in    still tired after the wait, or a first sign of drowsiness
// Level 3  emergency        eyes shut too long, or drowsy again after MYRA's check-in
//
// Two kinds of time are used. Eye closure is always real seconds (a blink is a blink).
// Waits (Level 1 -> 2, snooze, recovery) run on a "simulated" clock that demo mode speeds
// up, so a 1-minute wait shows as 1:00 on screen but passes in 10 s.

export type FatigueLevel = 0 | 1 | 2 | 3;
export type ContextRisk = 'normal' | 'elevated' | 'high';

/**
 * What the driver monitor reports, reduced to what the response needs.
 * off: monitoring is not running (camera panel closed or engine off).
 * unavailable: face not visible / low confidence / still calibrating; nothing is concluded.
 * blocked: the camera lens is covered; never treated as drowsiness.
 */
export type DriverSignal = 'off' | 'unavailable' | 'blocked' | 'alert' | 'tired' | 'drowsy';

export interface FatigueInput {
  signal: DriverSignal;
  /** Length of the current eye closure, real seconds. */
  closedS: number;
  /** The monitor's own explanation ("Slow, heavy blinking"), used in the timeline. */
  reason: string;
  /** Clock time is in the high-risk night window. */
  night: boolean;
  /** Continuous driving time, minutes. */
  drivingMin: number;
}

export type Question = 'none' | 'pending' | 'accepted' | 'declined' | 'unanswered';

export interface FatigueSnapshot {
  level: FatigueLevel;
  risk: ContextRisk;
  limits: Limits;
  /** Simulated seconds spent tired at Level 1, toward the Level 2 wait. */
  tiredS: number;
  /** Simulated seconds of snooze left after the driver said "no"; 0 when not snoozed. */
  snoozeLeftS: number;
  /** Simulated seconds of continuous alertness, toward recovery. */
  alertS: number;
  /** Real seconds the camera has been blocked. */
  blockedS: number;
  question: Question;
}

export type FatigueEvent =
  | { kind: 'level'; level: FatigueLevel; from: FatigueLevel; why: string }
  | { kind: 'ask' }
  | { kind: 'answer'; yes: boolean }
  | { kind: 'no-answer' }
  | { kind: 'recovered' }
  | { kind: 'blocked' }
  | { kind: 'unblocked' }
  | { kind: 'context'; risk: ContextRisk; from: ContextRisk };

export interface Limits {
  /** Simulated seconds of continued tiredness before Level 1 becomes Level 2. */
  l2WaitS: number;
  /** Real seconds of continuous eye closure that jump straight to Level 3. */
  l3ClosedS: number;
}

/** Night window: the hours when fatigue-related crashes peak. */
export const NIGHT_FROM_H = 0;
export const NIGHT_TO_H = 5;
/** Continuous driving after which a trip counts as long. */
export const LONG_TRIP_MIN = 120;
/** How the wait and the eye-closure limit tighten with context risk. */
export const LIMITS: Record<ContextRisk, Limits> = {
  normal: { l2WaitS: 60, l3ClosedS: 5 },
  elevated: { l2WaitS: 40, l3ClosedS: 4 },
  high: { l2WaitS: 20, l3ClosedS: 3 },
};
/** Demo mode runs waits six times faster: 60 s shows as 1:00 but takes 10 s. */
export const DEMO_TIME_SCALE = 6;
/** Simulated seconds of continuous alertness that end an episode and restore the cabin. */
export const RECOVER_S = 30;
/** Simulated seconds MYRA stays quiet after the driver declines a break. */
export const SNOOZE_S = 600;
/** Real seconds of a covered camera before the driver is told monitoring is paused. */
export const BLOCKED_NOTICE_S = 10;
/** Real seconds to wait for an answer to the Level 2 question. */
export const ANSWER_TIMEOUT_S = 15;

export const isNight = (hour: number) => hour >= NIGHT_FROM_H && hour < NIGHT_TO_H;

export function contextRisk(night: boolean, drivingMin: number): ContextRisk {
  const factors = (night ? 1 : 0) + (drivingMin >= LONG_TRIP_MIN ? 1 : 0);
  return factors === 0 ? 'normal' : factors === 1 ? 'elevated' : 'high';
}

/** m:ss for simulated seconds, as the on-screen countdowns show them. */
export function clock(s: number): string {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

// Hinglish and English answers to "Thak gaye? ... rukein?". "No" is checked first, so
// "nahi, theek hoon" is a no while "haan, theek hai" is a yes.
const NO = /\b(nahi|nahin|nai|na|no|nope|mat|not now|later|baad mein|theek hoon|thik hoon|theek hu|thik hu|i'?m fine|i am fine|i'?m ok(ay)?)\b/i;
const YES = /\b(haan|han|haa|ha|hanji|ji|yes|yeah|yep|ok|okay|sure|chalo|chaliye|rukte|rukein|ruko|rukenge|theek hai|thik hai|zaroor|please|let'?s go)\b/i;

/** Reads a spoken or typed reply to the Level 2 question; null when it is neither. */
export function parseYesNo(text: string): boolean | null {
  if (NO.test(text)) return false;
  if (YES.test(text)) return true;
  return null;
}

export class FatigueController {
  timeScale = 1;
  private level: FatigueLevel = 0;
  private risk: ContextRisk = 'normal';
  private lastT: number | null = null;
  private simT = 0;
  private tiredS = 0;
  private alertS = 0;
  private blockedS = 0;
  private blockedNoticed = false;
  private snoozeUntil = -Infinity;
  private question: Question = 'none';
  private askedAt = 0;
  private wasDrowsy = false;

  snapshot(): FatigueSnapshot {
    return {
      level: this.level,
      risk: this.risk,
      limits: LIMITS[this.risk],
      tiredS: this.tiredS,
      snoozeLeftS: Math.max(0, this.snoozeUntil - this.simT),
      alertS: this.alertS,
      blockedS: this.blockedS,
      question: this.question,
    };
  }

  /** End any episode at once (presenter reset, monitor switched off). */
  reset(): FatigueEvent[] {
    const events: FatigueEvent[] = this.level > 0 ? [{ kind: 'recovered' }] : [];
    this.level = 0;
    this.tiredS = 0;
    this.alertS = 0;
    this.question = 'none';
    this.wasDrowsy = false;
    this.snoozeUntil = -Infinity;
    if (this.blockedNoticed) events.push({ kind: 'unblocked' });
    this.blockedS = 0;
    this.blockedNoticed = false;
    return events;
  }

  /** Presenter shortcut: jump to a level as if the driver's condition had led there. */
  force(level: Exclude<FatigueLevel, 0>, t: number): FatigueEvent[] {
    this.lastT ??= t;
    const events: FatigueEvent[] = [];
    if (level === 2) {
      this.snoozeUntil = -Infinity;
      if (this.question !== 'pending') this.question = 'none';
    }
    this.go(level, 'Presenter trigger', events, t);
    if (level === 1) this.tiredS = 0;
    // A presenter check-in always asks, even when stepping down from Level 3.
    if (level === 2 && this.question === 'none') {
      this.question = 'pending';
      this.askedAt = t;
      events.push({ kind: 'ask' });
    }
    return events;
  }

  /** The driver's yes/no to the Level 2 question. */
  answer(yes: boolean, t: number): FatigueEvent[] {
    if (this.question !== 'pending' && this.question !== 'unanswered') return [];
    const events: FatigueEvent[] = [{ kind: 'answer', yes }];
    if (yes) {
      this.question = 'accepted';
    } else {
      this.question = 'declined';
      this.snoozeUntil = this.simT + SNOOZE_S;
      // Back to the cabin measures only; Level 3 can still fire.
      if (this.level === 2) this.go(1, 'Driver declined a break: check-in snoozed', events, t);
      this.tiredS = 0;
    }
    return events;
  }

  /** One monitor reading at time `t` (ms). */
  update(t: number, input: FatigueInput): FatigueEvent[] {
    const dtReal = this.lastT === null ? 0 : Math.min(1, Math.max(0, (t - this.lastT) / 1000));
    this.lastT = t;
    const dt = dtReal * this.timeScale;
    this.simT += dt;
    const events: FatigueEvent[] = [];

    const risk = contextRisk(input.night, input.drivingMin);
    if (risk !== this.risk) {
      events.push({ kind: 'context', risk, from: this.risk });
      this.risk = risk;
    }
    const limits = LIMITS[risk];

    if (input.signal === 'off') {
      events.push(...this.reset());
      return events;
    }

    // A covered camera says nothing about the driver: hold the level, pause every timer.
    if (input.signal === 'blocked') {
      this.blockedS += dtReal;
      if (!this.blockedNoticed && this.blockedS >= BLOCKED_NOTICE_S) {
        this.blockedNoticed = true;
        events.push({ kind: 'blocked' });
      }
      return events;
    }
    if (this.blockedNoticed) events.push({ kind: 'unblocked' });
    this.blockedS = 0;
    this.blockedNoticed = false;

    if (this.question === 'pending' && t - this.askedAt >= ANSWER_TIMEOUT_S * 1000) {
      this.question = 'unanswered';
      events.push({ kind: 'no-answer' });
    }

    if (input.signal === 'unavailable') return events;

    const drowsy = input.signal === 'drowsy';
    const newDrowsy = drowsy && !this.wasDrowsy;
    this.wasDrowsy = drowsy;
    const snoozed = this.simT < this.snoozeUntil;

    // Eyes shut too long: emergency from any level.
    if (input.closedS >= limits.l3ClosedS) {
      if (this.level < 3) this.go(3, `Eyes closed for ${input.closedS.toFixed(1)} s`, events, t);
      this.alertS = 0;
      return events;
    }

    if (drowsy) {
      this.alertS = 0;
      if (newDrowsy) {
        if (this.level >= 2 || snoozed) {
          if (this.level < 3) {
            const why = this.level >= 2 ? `Drowsy despite MYRA's check-in: ${lower(input.reason)}` : `Drowsy after declining a break: ${lower(input.reason)}`;
            this.go(3, why, events, t);
          }
        } else {
          this.go(2, `Drowsiness detected: ${lower(input.reason)}`, events, t);
        }
      }
      return events;
    }

    // Eyes open again after the emergency: stop the alarm, keep the stop advice and hazards.
    if (this.level === 3) this.go(2, 'Driver responded: eyes open again', events, t);

    if (input.signal === 'tired') {
      this.alertS = 0;
      if (this.level === 0) {
        this.go(1, input.reason, events, t);
      } else if (this.level === 1 && !snoozed) {
        this.tiredS += dt;
        if (this.tiredS >= limits.l2WaitS) this.go(2, `Still tired after ${clock(limits.l2WaitS)}`, events, t);
      }
      return events;
    }

    // Alert: a calm stretch ends the episode.
    if (this.level > 0) {
      this.alertS += dt;
      if (this.alertS >= RECOVER_S) {
        this.level = 0;
        this.tiredS = 0;
        this.alertS = 0;
        this.question = 'none';
        events.push({ kind: 'recovered' });
      }
    }
    return events;
  }

  private go(level: FatigueLevel, why: string, events: FatigueEvent[], t: number) {
    const from = this.level;
    if (level === from) return;
    this.level = level;
    this.alertS = 0;
    if (level === 1) this.tiredS = 0;
    events.push({ kind: 'level', level, from, why });
    // MYRA asks once per episode, and not while snoozed; stepping down from Level 3 never re-asks.
    if (level === 2 && from < 2 && (this.question === 'none' || this.question === 'declined') && !(this.simT < this.snoozeUntil)) {
      this.question = 'pending';
      this.askedAt = t;
      events.push({ kind: 'ask' });
    }
  }
}

const lower = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
