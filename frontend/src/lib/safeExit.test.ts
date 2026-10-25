import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectTracker, type RawDetection, type TrackedObject } from './objectTracking.ts';
import { DEFAULT_SAFETY_CONFIG, SafeExitSafetyEngine, transitionSimulatedDoor, type SafetyConfig } from './safeExit.ts';

const detection = (x: number, y = 0.3): RawDetection => ({
  className: 'car',
  label: 'car',
  confidence: 0.86,
  box: { x, y, width: 0.22, height: 0.24 },
});

function trackedObject(overrides: Partial<TrackedObject> = {}): TrackedObject {
  return {
    trackId: 7,
    className: 'car',
    label: 'car',
    confidence: 0.86,
    box: { x: 0.6, y: 0.3, width: 0.2, height: 0.24 },
    center: { x: 0.7, y: 0.42 },
    movement: {
      dx: 0.08,
      dy: 0,
      speed: 0.08,
      direction: 'right',
      scaleDelta: 0,
      sizeTrend: 'stable',
    },
    ageFrames: 5,
    missedFrames: 0,
    confirmed: true,
    firstSeenAt: 0,
    lastSeenAt: 0,
    timestampMs: 0,
    ...overrides,
  };
}

function confirmedWarning(engine: SafeExitSafetyEngine, config: SafetyConfig = DEFAULT_SAFETY_CONFIG) {
  let decision = engine.evaluate({ objects: [trackedObject()], cameraState: 'ready', now: 0, config });
  assert.equal(decision.state, 'MONITORING');
  for (let frame = 1; frame < config.confirmationFrames; frame++) {
    decision = engine.evaluate({ objects: [trackedObject()], cameraState: 'ready', now: frame * 100, config });
  }
  return decision;
}

test('keeps a track id stable across nearby frames and a short disappearance', () => {
  const tracker = new ObjectTracker({ confirmationFrames: 2 });
  const first = tracker.update([detection(0.18)], 0)[0];
  const second = tracker.update([detection(0.21)], 100)[0];
  assert.equal(second.trackId, first.trackId);
  assert.equal(second.confirmed, true);
  assert.equal(second.movement.direction, 'right');

  tracker.update([], 200);
  const reappeared = tracker.update([detection(0.25)], 300)[0];
  assert.equal(reappeared.trackId, first.trackId);
});

test('requires temporal confirmation before warning for an approaching object in the door zone', () => {
  const decision = confirmedWarning(new SafeExitSafetyEngine());
  assert.equal(decision.state, 'WARNING');
  assert.equal(decision.risk, true);
  assert.equal(decision.warning, true);
  assert.equal(decision.alert, true);
  assert.match(decision.message, /door zone/i);
});

test('person detections produce a specific warning when they approach inside the door zone', () => {
  const engine = new SafeExitSafetyEngine();
  const person = trackedObject({ className: 'person', label: 'person' });
  let decision = engine.evaluate({ objects: [person], cameraState: 'ready', now: 0, config: DEFAULT_SAFETY_CONFIG });
  assert.equal(decision.state, 'MONITORING');
  for (let frame = 1; frame <= DEFAULT_SAFETY_CONFIG.confirmationFrames; frame++) {
    decision = engine.evaluate({ objects: [person], cameraState: 'ready', now: frame * 100, config: DEFAULT_SAFETY_CONFIG });
  }
  assert.equal(decision.state, 'WARNING');
  assert.match(decision.message, /^Person detected near the door zone/);
});

test('the simulated door opens even when a warning is active and resets closed', () => {
  const openedWithWarning = transitionSimulatedDoor('CLOSED', 'OPEN_REQUEST');
  assert.deepEqual(openedWithWarning, {
    state: 'OPEN',
    opened: true,
    message: 'Door opened. Check the Safe Exit warning.',
  });

  const opened = transitionSimulatedDoor('CLOSED', 'OPEN_REQUEST');
  assert.equal(opened.state, 'OPEN');
  assert.equal(opened.opened, true);

  const reset = transitionSimulatedDoor('OPEN', 'RESET');
  assert.equal(reset.state, 'CLOSED');
});

test('objects outside the configured danger zone do not warn', () => {
  const engine = new SafeExitSafetyEngine();
  const outside = trackedObject({
    box: { x: 0.05, y: 0.3, width: 0.2, height: 0.24 },
    center: { x: 0.15, y: 0.42 },
  });
  for (let frame = 0; frame < 6; frame++) {
    const decision = engine.evaluate({ objects: [outside], cameraState: 'ready', now: frame * 100, config: DEFAULT_SAFETY_CONFIG });
    assert.notEqual(decision.state, 'WARNING');
    assert.equal(decision.warning, false);
  }
});

test('a stationary object inside the zone does not trigger a warning', () => {
  const engine = new SafeExitSafetyEngine();
  const stationary = trackedObject({
    movement: {
      dx: 0,
      dy: 0,
      speed: 0,
      direction: 'still',
      scaleDelta: 0,
      sizeTrend: 'stable',
    },
  });
  for (let frame = 0; frame < 6; frame++) {
    const decision = engine.evaluate({ objects: [stationary], cameraState: 'ready', now: frame * 100, config: DEFAULT_SAFETY_CONFIG });
    assert.equal(decision.warning, false);
    assert.equal(decision.risk, false);
  }
});

test('an object moving away while inside the zone does not trigger a warning', () => {
  const engine = new SafeExitSafetyEngine();
  const movingAway = trackedObject({
    box: { x: 0.73, y: 0.3, width: 0.2, height: 0.24 },
    center: { x: 0.83, y: 0.42 },
    movement: {
      dx: 0.12,
      dy: 0,
      speed: 0.12,
      direction: 'right',
      scaleDelta: 0,
      sizeTrend: 'stable',
    },
  });
  for (let frame = 0; frame < 6; frame++) {
    const decision = engine.evaluate({ objects: [movingAway], cameraState: 'ready', now: frame * 100, config: DEFAULT_SAFETY_CONFIG });
    assert.equal(decision.warning, false);
  }
});

test('risk clears when the tracked object moves away from the door zone', () => {
  const engine = new SafeExitSafetyEngine();
  const warning = confirmedWarning(engine);
  assert.equal(warning.risk, true);

  const away = trackedObject({
    box: { x: 0.08, y: 0.3, width: 0.2, height: 0.24 },
    center: { x: 0.18, y: 0.42 },
    movement: { dx: -0.16, dy: 0, speed: 0.16, direction: 'left', scaleDelta: -0.1, sizeTrend: 'contracting' },
  });
  const cleared = engine.evaluate({ objects: [away], cameraState: 'ready', now: 500, config: DEFAULT_SAFETY_CONFIG });
  assert.equal(cleared.risk, false);
  assert.equal(cleared.warning, false);
  assert.equal(cleared.state, 'MONITORING');
});

test('warning audio is cooldown-gated and camera errors are explicit', () => {
  const engine = new SafeExitSafetyEngine();
  const first = confirmedWarning(engine);
  assert.equal(first.alert, true);

  const duringCooldown = engine.evaluate({ objects: [trackedObject()], cameraState: 'ready', now: 500, config: DEFAULT_SAFETY_CONFIG });
  assert.equal(duringCooldown.state, 'WARNING');
  assert.equal(duringCooldown.alert, false);

  let afterCooldown = engine.evaluate({ objects: [trackedObject()], cameraState: 'ready', now: 6100, config: DEFAULT_SAFETY_CONFIG });
  afterCooldown = engine.evaluate({ objects: [trackedObject()], cameraState: 'ready', now: 6200, config: DEFAULT_SAFETY_CONFIG });
  afterCooldown = engine.evaluate({ objects: [trackedObject()], cameraState: 'ready', now: 6300, config: DEFAULT_SAFETY_CONFIG });
  afterCooldown = engine.evaluate({ objects: [trackedObject()], cameraState: 'ready', now: 6400, config: DEFAULT_SAFETY_CONFIG });
  assert.equal(afterCooldown.alert, true);

  const cameraError = engine.evaluate({ objects: [], cameraState: 'error', now: 7000, config: DEFAULT_SAFETY_CONFIG });
  assert.equal(cameraError.state, 'CAMERA_ERROR');
});
