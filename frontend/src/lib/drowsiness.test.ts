import assert from 'node:assert/strict';
import test from 'node:test';
import { CALIBRATION_S, DROWSY_CLOSED_S, DrowsinessTracker, type FaceCues } from './drowsiness.ts';

const face = (eyeClosure: number, pitch = 0): FaceCues => ({
  eyeClosure, jawOpen: 0, confidence: 0.9, headPose: { yaw: 0, pitch, roll: 0 },
});

/** A calibrated tracker at time `t` ms, after a baseline of open eyes. */
function calibrated() {
  const tr = new DrowsinessTracker();
  let t = 0;
  for (let i = 0; i < (CALIBRATION_S + 2) * 30; i++) { t += 33; tr.update(t, face(0.05)); }
  return { tr, t };
}

test('eyes closed for 2.5 s reads as drowsy, 2.4 s does not', () => {
  assert.equal(DROWSY_CLOSED_S, 2.5);
  const { tr, t: t0 } = calibrated();
  let t = t0;
  let st = tr.update(t, face(0.95));
  while (t - t0 < 2400) { t += 33; st = tr.update(t, face(0.95)); }
  assert.notEqual(st.state, 'drowsy');
  while (t - t0 < 2550) { t += 33; st = tr.update(t, face(0.95)); }
  assert.equal(st.state, 'drowsy');
  assert.ok(st.closedS >= 2.5);
});

test('a head nodding forward with the eyes shut keeps counting the closure', () => {
  const { tr, t: t0 } = calibrated();
  let t = t0;
  // Eyes close with the head level...
  for (let i = 0; i < 15; i++) { t += 33; tr.update(t, face(0.95)); }
  // ...then the head drops forward, too steep to read the eyes.
  let st = tr.update(t, face(0.95, 0.8));
  while (t - t0 < 3000) { t += 33; st = tr.update(t, face(0.4, 0.8)); }
  assert.equal(st.state, 'drowsy');
  assert.ok(st.closedS >= 2.5, `closedS ${st.closedS}`);
});

test('looking down with the eyes open is not a nod', () => {
  const { tr, t: t0 } = calibrated();
  let t = t0;
  let st = tr.update(t, face(0.05, 0.8));
  while (t - t0 < 3000) { t += 33; st = tr.update(t, face(0.05, 0.8)); }
  assert.notEqual(st.state, 'drowsy');
  assert.equal(st.closedS, 0);
});
