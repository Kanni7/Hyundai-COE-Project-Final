// Side view of the driver's seat: the memory seat and steering column move to the active profile's
// position (lib/profiles.ts fitFor), with a mannequin of the driver's size, so a profile change shows
// the seat rising and sliding and the wheel tilting. Geometry in cm (lib/profiles.ts CABIN), drawn with
// the car facing left: svg x = car x (rearward), svg y = -car y (up).

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { CarState, Intent, ProfileId } from '../types';
import { backend, recordAudio, type SpeakerStatus } from '../lib/backend';
import { body, CABIN, fitFor, PROFILES, type Fit, useProfileIds, useProfiles } from '../lib/profiles';
import { AddProfileModal } from './AddProfileModal';

type Pt = [number, number];
const RAD = Math.PI / 180;
const at = (p: Pt, len: number, deg: number): Pt => [p[0] + len * Math.cos(deg * RAD), p[1] + len * Math.sin(deg * RAD)];
const svg = ([x, y]: Pt) => `${x.toFixed(1)},${(-y).toFixed(1)}`;
const line = (...pts: Pt[]) => `M${pts.map(svg).join('L')}`;

/** Two-link limb from `a` towards `b` (clamped to its reach); `pick` chooses the joint (knee up, elbow down). */
function limb(a: Pt, b: Pt, l1: number, l2: number, pick: (j1: Pt, j2: Pt) => Pt): [Pt, Pt] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const d = Math.min(Math.hypot(dx, dy), l1 + l2 - 0.01);
  const base = Math.atan2(dy, dx) / RAD;
  const bend = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)))) / RAD;
  const joint = pick(at(a, l1, base + bend), at(a, l1, base - bend));
  return [joint, at(a, d, base)];
}

/** Eases every number of the fit towards a new target, like the seat motors (instant with reduced motion). */
function useTween(target: Fit, ms = 1400): Fit {
  const [cur, setCur] = useState(target);
  const ref = useRef(target);
  useEffect(() => {
    const from = ref.current;
    const t0 = performance.now();
    const instant = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    const step = (now: number) => {
      const k = instant ? 1 : Math.min(1, (now - t0) / ms);
      const e = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
      const next = { ...target };
      for (const key of Object.keys(target) as (keyof Fit)[]) next[key] = from[key] + (target[key] - from[key]) * e;
      ref.current = next;
      setCur(next);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return cur;
}

/** Sentences for voice enrollment: mixed Hindi/English, like real commands, and long enough (~3 s). */
const ENROLL_LINES = [
  (name: string) => `Hey Verna, main ${name} hoon. AC ko bayees degree pe kar do aur thoda music chalao.`,
  () => 'Navigate to the nearest petrol pump, and turn the ambient light blue.',
  () => 'Fan ki speed kam karo, window thodi kholo, aur volume badha do.',
];
const ENROLL_TARGET = ENROLL_LINES.length;

/** Teach the car the active driver's voice, so speaking a command switches to their profile. */
function VoiceId({ profile, name }: { profile: ProfileId; name: string }) {
  const [status, setStatus] = useState<SpeakerStatus | null | undefined>(undefined); // undefined: loading, null: no backend
  const [rec, setRec] = useState<{ stop: () => unknown } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { backend.speakers().then(setStatus, () => setStatus(null)); }, []);

  if (status === undefined) return null;
  if (!status?.ready) return <div className="voice-id"><small>Voice ID</small><p>Needs the backend with its speaker model.</p></div>;
  if (profile === 'default') {
    return (
      <div className="voice-id">
        <small>Voice ID</small>
        <p>Default profile is for guests. Add a driver profile to save personalized seat and voice recognition.</p>
      </div>
    );
  }
  const n = status.enrolled[profile] ?? 0;

  const record = async () => {
    if (rec) { rec.stop(); return; }
    try {
      setMsg('');
      const r = await recordAudio(9000, 1300);
      setRec(r);
      const audio = await r.done;
      setRec(null);
      setBusy(true);
      const res = await backend.enroll(profile, audio);
      setStatus((st) => st && { ...st, enrolled: { ...st.enrolled, [profile]: res.samples } });
      setMsg(res.samples >= ENROLL_TARGET ? `Done: the car now knows ${name}'s voice.` : 'Got it. Next sentence:');
    } catch (e) {
      setRec(null);
      setMsg(e instanceof Error && e.message ? e.message : 'Recording failed');
    } finally {
      setBusy(false);
    }
  };
  const forget = async () => {
    await backend.forget(profile).catch(() => {});
    setStatus((st) => st && { ...st, enrolled: { ...st.enrolled, [profile]: 0 } });
    setMsg(`${name}'s voiceprint deleted.`);
  };

  return (
    <div className="voice-id">
      <small>Voice ID</small>
      <p>{n >= ENROLL_TARGET ? `Recognises ${name}'s voice: speaking a command switches to this profile.`
        : n ? `${n} of ${ENROLL_TARGET} sentences recorded.` : `Teach the car ${name}'s voice: read ${ENROLL_TARGET} short sentences.`}</p>
      {n < ENROLL_TARGET && <blockquote>“{ENROLL_LINES[n % ENROLL_TARGET](name)}”</blockquote>}
      {msg && <p className="voice-id-msg" role="status">{msg}</p>}
      <div className="voice-id-btns">
        <button className={rec ? 'rec' : ''} disabled={busy} onClick={() => void record()}>
          {rec ? 'Stop' : busy ? 'Saving…' : n >= ENROLL_TARGET ? 'Add another sentence' : 'Record sentence'}
        </button>
        {n > 0 && <button onClick={() => void forget()} disabled={busy || !!rec}>Forget voice</button>}
      </div>
    </div>
  );
}

const DASH_PEAK: Pt = [6, 86];
const ROAD_Y = -20; // road surface below the cabin floor

export function SeatView({ car, onIntent }: { car: CarState; onIntent: (i: Intent) => void }) {
  const profileIds = useProfileIds();
  const profiles = useProfiles();
  const [showAddModal, setShowAddModal] = useState(false);
  const p = profiles[car.profile] ?? PROFILES[car.profile];
  const target = useMemo(() => fitFor(p), [p]);
  const f = useTween(target);
  const b = body(f.heightCm);

  const hip: Pt = [CABIN.hip.x + f.slideMm / 10, CABIN.hip.y + f.liftMm / 10];
  const lean = 90 - f.reclineDeg; // torso direction from +x
  const shoulder = at(hip, b.torso, lean);
  const headC = at(shoulder, b.head * 0.85, 90 - f.reclineDeg * 0.3);
  const eye: Pt = [headC[0] - 0.045 * f.heightCm, headC[1] + 0.01 * f.heightCm];
  const ankle: Pt = [CABIN.pedal.x + 12, CABIN.pedal.y];
  const toe: Pt = [CABIN.pedal.x - 4, CABIN.pedal.y + 9];
  const [knee, foot] = limb(hip, ankle, b.thigh, b.leg - b.thigh - 0.045 * f.heightCm, (j1, j2) => (j1[1] > j2[1] ? j1 : j2));

  const col: Pt = [CABIN.column.x, CABIN.column.y];
  const wheel = at(col, CABIN.column.length + f.wheelReachMm / 10, f.wheelTiltDeg);
  const rimTop = at(wheel, 18.5, f.wheelTiltDeg + 90);
  const rimLow = at(wheel, 18.5, f.wheelTiltDeg - 90);
  const grip = at(wheel, 10, f.wheelTiltDeg + 90);
  const [elbow, hand] = limb(shoulder, grip, b.upperArm, b.forearm, (j1, j2) => (j1[1] < j2[1] ? j1 : j2));

  // Sightline from the eye over the top of the dashboard down to the road: how close ahead the driver sees.
  const slope = (eye[1] - DASH_PEAK[1]) / (eye[0] - DASH_PEAK[0]);
  const roadAheadM = slope > 0 ? (eye[1] - ROAD_Y) / slope / 100 : Infinity; // measured from the eye
  const sightEnd: Pt = [DASH_PEAK[0] - 70, DASH_PEAK[1] - slope * 70];

  const seatAt = `translate(${hip[0].toFixed(1)} ${(-hip[1]).toFixed(1)})`;
  const headrestY = -Math.min(84, Math.max(70, b.torso + b.head * 0.8));
  const stats: [string, string][] = [
    ['Seat height', `+${Math.round(f.liftMm)} mm`],
    ['Seat travel', `${Math.round(f.slideMm)} mm back`],
    ['Backrest', `${f.reclineDeg.toFixed(0)}°`],
    ['Steering tilt', `${f.wheelTiltDeg.toFixed(0)}°`],
    ['Steering reach', `+${Math.round(f.wheelReachMm)} mm`],
    ['Road visible from', Number.isFinite(roadAheadM) ? `${roadAheadM.toFixed(1)} m ahead` : '—'],
  ];

  return (
    <section className="seatview" style={{ '--pc': p.accent } as CSSProperties} aria-label="Driver seat position">
      <svg className="seat-svg" viewBox="-60 -132 260 140" role="img"
        aria-label={`Side view: ${p.name}, ${p.heightCm} cm, seat ${target.liftMm} mm up and ${target.slideMm} mm back`}>
        <defs>
          <linearGradient id="sv-glass" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#5fa8ff" stopOpacity="0.16" />
            <stop offset="1" stopColor="#5fa8ff" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* Cabin shell */}
        <path className="sv-glass" d={`${line([-8, 87], [62, 122], [62, 87])}Z`} fill="url(#sv-glass)" />
        <path className="sv-shell" d={line([-60, 0], [8, 0], [-14, 26], [-22, 44])} />
        <path className="sv-shell" d={line([-8, 87], [62, 122])} />
        <path className="sv-shell" d={`M${svg([62, 122])}Q${svg([125, 129])} ${svg([200, 123])}`} />
        <path className="sv-floor" d={line([8, 0], [200, 0])} />
        <path className="sv-dash" d={`M${svg([-22, 44])}L${svg([-26, 72])}Q${svg([-22, 86])} ${svg([DASH_PEAK[0], 87])}L${svg([28, 86])}Q${svg([38, 85])} ${svg([42, 77])}L${svg([43, 66])}Q${svg([30, 58])} ${svg([18, 52])}L${svg([-22, 44])}Z`} />
        <path className="sv-rail" d={line([58, 3], [150, 3])} />
        <path className="sv-pedal" d={line([6, 4], [-2, 22])} />

        <path className="sv-sight" d={line(eye, sightEnd)} />

        {/* Seat: base on the rails, cushion, backrest and headrest move with the hip point */}
        <g transform={seatAt}>
          <rect className="sv-base" x={-30} y={20} width={36} height={Math.max(2, hip[1] - 25)} rx={2} />
          <path className="sv-seat" d="M-48,5 L6,10 Q14,11 14,18 L12,22 L-44,17 Q-50,14 -48,5Z" />
          <g transform={`rotate(${f.reclineDeg.toFixed(2)})`}>
            <rect className="sv-seat" x={9} y={-60} width={13} height={68} rx={6} />
            <rect className="sv-seat" x={7} y={headrestY - 8} width={11} height={16} rx={4} />
          </g>
        </g>

        {/* Steering column and wheel */}
        <path className="sv-column" d={line(col, wheel)} />
        <path className="sv-wheel" d={line(rimTop, rimLow)} />
        <circle className="sv-hub" cx={wheel[0]} cy={-wheel[1]} r={4} />

        {/* Driver */}
        <g className="sv-body">
          <path d={line(hip, knee, foot, toe)} strokeWidth={0.075 * f.heightCm} />
          <path d={line(hip, shoulder)} strokeWidth={0.13 * f.heightCm} />
          <path d={line(shoulder, elbow, hand)} strokeWidth={0.045 * f.heightCm} />
          <circle cx={headC[0]} cy={-headC[1]} r={0.062 * f.heightCm} />
        </g>
        <circle className="sv-eye" cx={eye[0]} cy={-eye[1]} r={1.3} />
        <circle className="sv-hpoint" cx={hip[0]} cy={-hip[1]} r={1.6} />
      </svg>

      <aside className="seat-panel">
        <small>Driver profile</small>
        <h2>{p.name} <span>{p.heightCm} cm · {p.weightKg} kg</span></h2>
        <p className="seat-build">{p.build}</p>
        <dl>
          {stats.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
        <div className="seat-profiles" role="radiogroup" aria-label="Driver profile">
          {profileIds.map((id) => {
            const q = profiles[id] ?? PROFILES[id];
            return (
              <button key={id} role="radio" aria-checked={id === car.profile} className={id === car.profile ? 'on' : ''}
                style={{ '--pc': q.accent } as CSSProperties} onClick={() => onIntent({ type: 'profile', id })}>
                <i>{q.name[0]}</i><b>{q.name}</b><span>{q.heightCm} cm</span>
              </button>
            );
          })}
          <button type="button" className="seat-add-btn" onClick={() => setShowAddModal(true)} title="Add new driver profile">
            <i>+</i><b>Add Profile</b><span>Personalized</span>
          </button>
        </div>
        <p className="seat-hint">Speak any command to auto-detect your profile, or pick above.</p>
        <AddProfileModal isOpen={showAddModal} onClose={() => setShowAddModal(false)} onProfileCreated={(np) => onIntent({ type: 'profile', id: np.id })} />
        <VoiceId key={car.profile} profile={car.profile} name={p.name} />
      </aside>
    </section>
  );
}
