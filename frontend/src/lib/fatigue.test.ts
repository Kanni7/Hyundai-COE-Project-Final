import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANSWER_TIMEOUT_S,
  BLOCKED_NOTICE_S,
  DEMO_TIME_SCALE,
  FatigueController,
  RECOVER_S,
  contextRisk,
  isNight,
  parseYesNo,
  type DriverSignal,
  type FatigueEvent,
  type FatigueInput,
} from './fatigue.ts';

const input = (signal: DriverSignal, extra: Partial<FatigueInput> = {}): FatigueInput => ({
  signal, closedS: 0, reason: 'Slow, heavy blinking', night: false, drivingMin: 10, ...extra,
});

/** Feeds `seconds` of readings at 10 Hz, starting at `from` ms; returns the end time and every event. */
function run(c: FatigueController, from: number, seconds: number, make: (t: number) => FatigueInput) {
  const events: FatigueEvent[] = [];
  let t = from;
  for (let i = 0; i < seconds * 10; i++) {
    t += 100;
    events.push(...c.update(t, make(t)));
  }
  return { t, events };
}

const levels = (events: FatigueEvent[]) => events.flatMap((e) => (e.kind === 'level' ? [e.level] : []));

test('tired driver gets Level 1, then Level 2 after the one-minute wait', () => {
  const c = new FatigueController();
  let r = run(c, 0, 1, () => input('tired'));
  assert.deepEqual(levels(r.events), [1]);
  r = run(c, r.t, 55, () => input('tired'));
  assert.equal(c.snapshot().level, 1);
  r = run(c, r.t, 6, () => input('tired'));
  assert.deepEqual(levels(r.events), [2]);
  assert.ok(r.events.some((e) => e.kind === 'ask'));
});

test('demo timing reaches Level 2 in about 10 real seconds', () => {
  const c = new FatigueController();
  c.timeScale = DEMO_TIME_SCALE;
  let r = run(c, 0, 1, () => input('tired'));
  r = run(c, r.t, 8.5, () => input('tired'));
  assert.equal(c.snapshot().level, 1);
  r = run(c, r.t, 1.5, () => input('tired'));
  assert.equal(c.snapshot().level, 2);
});

test('eyes closed for 5 s jumps straight to Level 3', () => {
  const c = new FatigueController();
  run(c, 0, 1, () => input('alert'));
  const ev = c.update(1200, input('drowsy', { closedS: 5.1, reason: 'Eyes closed for 5.1 s' }));
  assert.deepEqual(levels(ev), [3]);
});

test('a first sign of drowsiness asks (Level 2); a second one is an emergency', () => {
  const c = new FatigueController();
  let r = run(c, 0, 1, () => input('drowsy', { closedS: 2.2 }));
  assert.deepEqual(levels(r.events), [2]);
  r = run(c, r.t, 3, () => input('alert'));
  r = run(c, r.t, 1, () => input('drowsy', { closedS: 2.2 }));
  assert.deepEqual(levels(r.events), [3]);
  // Eyes open again: alarm stops (Level 2), stop advice stays.
  r = run(c, r.t, 1, () => input('alert'));
  assert.deepEqual(levels(r.events), [2]);
});

test('context tightens the limits but never triggers on its own', () => {
  assert.equal(contextRisk(false, 30), 'normal');
  assert.equal(contextRisk(true, 30), 'elevated');
  assert.equal(contextRisk(false, 150), 'elevated');
  assert.equal(contextRisk(true, 150), 'high');
  assert.ok(isNight(2) && !isNight(5) && !isNight(23));

  const c = new FatigueController();
  const r = run(c, 0, 120, () => input('alert', { night: true, drivingMin: 200 }));
  assert.deepEqual(levels(r.events), []);
  assert.equal(c.snapshot().risk, 'high');
  // 3 s of closed eyes is an emergency at high risk, not at normal risk.
  assert.deepEqual(levels(c.update(r.t + 100, input('drowsy', { closedS: 3.1, night: true, drivingMin: 200 }))), [3]);
  const calm = new FatigueController();
  run(calm, 0, 1, () => input('alert'));
  assert.ok(!levels(calm.update(1200, input('drowsy', { closedS: 3.1 }))).includes(3));
});

test('high-risk context shortens the Level 2 wait to 20 s', () => {
  const c = new FatigueController();
  const ctx = { night: true, drivingMin: 150 };
  let r = run(c, 0, 1, () => input('tired', ctx));
  r = run(c, r.t, 21, () => input('tired', ctx));
  assert.equal(c.snapshot().level, 2);
});

test('"no" snoozes the check-in, but Level 3 can still fire', () => {
  const c = new FatigueController();
  let r = run(c, 0, 1, () => input('drowsy', { closedS: 2.2 }));
  assert.equal(c.snapshot().question, 'pending');
  const ev = c.answer(false, r.t);
  assert.deepEqual(levels(ev), [1]);
  assert.ok(c.snapshot().snoozeLeftS > 590);
  // Tired for two more minutes: no new question while snoozed.
  r = run(c, r.t, 3, () => input('alert'));
  r = run(c, r.t, 120, () => input('tired'));
  assert.equal(c.snapshot().level, 1);
  assert.ok(!r.events.some((e) => e.kind === 'ask'));
  // Eyes shut: still an emergency.
  assert.deepEqual(levels(c.update(r.t + 100, input('drowsy', { closedS: 5.5 }))), [3]);
});

test('"yes" is remembered and not asked again in the same episode', () => {
  const c = new FatigueController();
  const r = run(c, 0, 1, () => input('drowsy', { closedS: 2.2 }));
  c.answer(true, r.t);
  assert.equal(c.snapshot().question, 'accepted');
  c.force(1, r.t);
  assert.ok(!c.update(r.t + 100, input('tired')).some((e) => e.kind === 'ask'));
});

test('unanswered questions time out', () => {
  const c = new FatigueController();
  const r = run(c, 0, 1, () => input('drowsy', { closedS: 2.2 }));
  const later = run(c, r.t, ANSWER_TIMEOUT_S + 1, () => input('tired'));
  assert.ok(later.events.some((e) => e.kind === 'no-answer'));
  assert.equal(c.snapshot().question, 'unanswered');
});

test('a calm stretch ends the episode', () => {
  const c = new FatigueController();
  let r = run(c, 0, 1, () => input('tired'));
  r = run(c, r.t, RECOVER_S - 2, () => input('alert'));
  assert.equal(c.snapshot().level, 1);
  r = run(c, r.t, 3, () => input('alert'));
  assert.ok(r.events.some((e) => e.kind === 'recovered'));
  assert.equal(c.snapshot().level, 0);
});

test('a blocked camera holds the level, never escalates, and is reported once', () => {
  const c = new FatigueController();
  let r = run(c, 0, 1, () => input('tired'));
  r = run(c, r.t, BLOCKED_NOTICE_S + 50, () => input('blocked'));
  assert.equal(c.snapshot().level, 1);
  assert.equal(r.events.filter((e) => e.kind === 'blocked').length, 1);
  assert.deepEqual(levels(r.events), []);
  r = run(c, r.t, 1, () => input('alert'));
  assert.ok(r.events.some((e) => e.kind === 'unblocked'));
});

test('face not visible pauses the timers instead of escalating', () => {
  const c = new FatigueController();
  let r = run(c, 0, 1, () => input('tired'));
  r = run(c, r.t, 300, () => input('unavailable'));
  assert.equal(c.snapshot().level, 1);
  assert.ok(c.snapshot().tiredS < 1);
});

test('switching monitoring off ends the episode', () => {
  const c = new FatigueController();
  const r = run(c, 0, 1, () => input('tired'));
  assert.ok(c.update(r.t + 100, input('off')).some((e) => e.kind === 'recovered'));
  assert.equal(c.snapshot().level, 0);
});

test('presenter triggers jump to a level and Level 2 always asks', () => {
  const c = new FatigueController();
  assert.deepEqual(levels(c.force(3, 0)), [3]);
  const ev = c.force(2, 100);
  assert.deepEqual(levels(ev), [2]);
  // Stepping down from 3 via the presenter still asks: it is a fresh check-in.
  assert.ok(ev.some((e) => e.kind === 'ask'));
  c.reset();
  assert.ok(c.force(2, 200).some((e) => e.kind === 'ask'));
});

test('yes/no answers in Hinglish and English', () => {
  for (const yes of ['Haan', 'haan ruk jaate hain', 'yes please', 'ok', 'chalo', 'theek hai']) assert.equal(parseYesNo(yes), true, yes);
  for (const no of ['Nahi', 'nahi, theek hoon', 'no thanks', "I'm fine", 'baad mein']) assert.equal(parseYesNo(no), false, no);
  assert.equal(parseYesNo('play some music'), null);
});
