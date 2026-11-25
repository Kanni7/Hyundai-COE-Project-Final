/** Where a centre vent is aimed: x from -1 (left) to 1 (right), y from -1 (up) to 1 (down). */
export interface VentAim { x: number; y: number }

/**
 * The two centre vents, passenger side first. The vent tabs write here as they are
 * dragged; the airflow reads it every frame, so aiming never re-renders React.
 */
export const ventAims: VentAim[] = [{ x: 0, y: 0 }, { x: 0, y: 0 }];

const listeners = new Set<() => void>();
let anim = 0;
let touchedAt = -Infinity;

/** The driver aiming a vent by hand. */
export function aimVent(i: number, aim: VentAim) {
  cancelAnimationFrame(anim);
  touchedAt = performance.now();
  ventAims[i] = aim;
}

/** When the driver last aimed a vent by hand (performance.now() time). */
export const ventsTouchedAt = () => touchedAt;

/** Called whenever the car (not the driver's hand) moves the vents, so the drawn tabs follow. */
export function onVentsMoved(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Swing the vents to new aims over `ms`, the way a motorised vent would: the drawn tabs,
 * vanes and air stream all follow frame by frame.
 */
export function animateVents(targets: VentAim[], ms = 1200) {
  cancelAnimationFrame(anim);
  const from = ventAims.map((a) => ({ ...a }));
  const start = performance.now();
  const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const step = (now: number) => {
    const k = ease(Math.min(1, (now - start) / ms));
    targets.forEach((to, i) => {
      if (!from[i]) return;
      ventAims[i] = { x: from[i].x + (to.x - from[i].x) * k, y: from[i].y + (to.y - from[i].y) * k };
    });
    listeners.forEach((fn) => fn());
    if (k < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

/** Both centre vents swung towards the driver's face (right-hand drive: the driver sits on the right). */
export const AIM_AT_DRIVER: VentAim[] = [{ x: 1, y: -0.35 }, { x: 0.65, y: -0.45 }];
