// Procedural Verna-style car body for the Acoustic Shield simulator.
// Ported from verna-video/src/lib/car.js (concept film); keep the two in step if the model changes.
import * as THREE from 'three';

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const smooth = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
export function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const hdr = (hex, k) => new THREE.Color(hex).multiplyScalar(k);
/** Smooth 1-D curve through [x, y] control points (Catmull-Rom on non-uniform x). */
export function curve1D(pts) {
  const n = pts.length;
  const m = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    return (b[1] - a[1]) / (b[0] - a[0] || 1);
  });
  return (x) => {
    if (x <= pts[0][0]) return pts[0][1];
    if (x >= pts[n - 1][0]) return pts[n - 1][1];
    let i = 0;
    while (x > pts[i + 1][0]) i++;
    const h = pts[i + 1][0] - pts[i][0], t = (x - pts[i][0]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * pts[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * pts[i + 1][1] + (t3 - t2) * h * m[i + 1];
  };
}
export function canvasTex(w, h, draw, opts = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = opts.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (opts.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  return t;
}
export const glowTex = canvasTex(256, 256, (g, w) => {
  const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.12, 'rgba(255,255,255,0.75)');
  r.addColorStop(0.35, 'rgba(255,255,255,0.18)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, w, w);
});
export const streakTex = canvasTex(512, 64, (g, w, h) => {
  const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,255,255,0.35)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.save(); g.translate(0, h / 2); g.scale(1, 0.09); g.translate(0, -h / 2); g.fillStyle = r; g.fillRect(0, -h * 6, w, h * 13); g.restore();
});
export function glowSprite(hex, size, k = 1, tex = glowTex) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: hdr(hex, k), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  s.scale.set(size, tex === streakTex ? size * 0.125 : size, 1);
  s.userData.base = hdr(hex, k);
  return s;
}

const N_SE = 5.0, E = 2 / N_SE;
const spow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);
const ARCH_GAP = 0.05;
const f3 = (v) => v.toFixed(4);
/** Black lower cladding and wheel wells, cut crisply in the fragment shader. */
function cladding(mat, sp, line) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vLoc;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvLoc = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vLoc;').replace('#include <color_fragment>', `#include <color_fragment>
      float cThr = ${f3(line)} + 0.15 * (1.0 - smoothstep(${f3(-sp.L / 2)}, ${f3(-sp.L / 2 + 0.55)}, vLoc.x));
      float cWell = step(0.5, abs(vLoc.z)) * step(min(length(vLoc.xy - vec2(${f3(sp.axF)}, ${f3(sp.wheelR)})), length(vLoc.xy - vec2(${f3(sp.axR)}, ${f3(sp.wheelR)}))), ${f3(sp.wheelR + ARCH_GAP + 0.007)});
      diffuseColor.rgb = mix(vec3(0.008), diffuseColor.rgb, smoothstep(cThr, cThr + 0.004, vLoc.y) * (1.0 - cWell));`);
  };
}

const VERNA = {
  L: 4.535, W: 1.765, axF: 1.3875, axR: -1.2825, wheelR: 0.335, track: 0.775,
  top: [[-2.2675, 0.95], [-2.2, 0.985], [-2.05, 1.01], [-1.75, 1.02], [-1.0, 0.985], [0, 0.955], [0.95, 0.93], [1.5, 0.87], [1.9, 0.80], [2.10, 0.775], [2.20, 0.735], [2.2675, 0.66]],
  bot: [[-2.2675, 0.36], [-2.1, 0.30], [-1.8, 0.24], [-1.0, 0.19], [1.0, 0.19], [1.9, 0.20], [2.15, 0.22], [2.2675, 0.25]],
  wid: [[-2.2675, 0.70], [-2.1, 0.80], [-1.6, 0.865], [-0.5, 0.8825], [0.6, 0.8825], [1.5, 0.87], [2.05, 0.80], [2.2675, 0.70]],
  roof: [[-1.9, 1.0], [-1.65, 1.10], [-1.3, 1.28], [-0.9, 1.42], [-0.5, 1.47], [-0.1, 1.465], [0.2, 1.41], [0.45, 1.30], [0.75, 1.10], [1.0, 0.92]],
  gx0: -1.9, gx1: 1.0, bowF: 0.30, bowR: 0.20, roofX: [-0.98, 0.22], sideGlassX: [-1.22, 0.62],
};

function makeSurface(sp) {
  const top = curve1D(sp.top), bot = curve1D(sp.bot), wid = curve1D(sp.wid), Lh = sp.L / 2, BULGE = 0.05;
  const warp = (X, x, z) => {
    const q = Math.pow(Math.abs(z) / (sp.W / 2), 2.4);
    if (x > 1.2) X -= sp.bowF * q * smooth((x - 1.2) / (Lh - 1.2));
    if (x < -1.4) X += sp.bowR * q * smooth((-x - 1.4) / (Lh - 1.4));
    return X;
  };
  const sec = (x) => { const yt = top(x), yb = bot(x); return { w: wid(x), yc: (yt + yb) / 2, hh: (yt - yb) / 2 }; };
  /** point on the body side at station x and height y (sgn = +1 right / -1 left) */
  const sidePoint = (x, y, sgn) => {
    const s = sec(x), f = Math.min(Math.abs((y - s.yc) / s.hh), 1);
    const z = s.w * Math.pow(1 - Math.pow(f, N_SE), 1 / N_SE);
    return new THREE.Vector3(warp(x, x, z), y, sgn * z);
  };
  /** point on the nose (end=+1) or tail (end=-1) face */
  const capPoint = (end, y, z) => {
    const x0 = end * Lh, s = sec(x0);
    const r = Math.min(Math.pow(Math.pow(Math.abs(z) / s.w, N_SE) + Math.pow(Math.abs(y - s.yc) / s.hh, N_SE), 1 / N_SE), 1);
    return new THREE.Vector3(warp(x0 + end * BULGE * (1 - r * r), x0, z), y, z);
  };
  const capEdge = (end, y) => { const s = sec(end * Lh), f = Math.min(Math.abs((y - s.yc) / s.hh), 1); return s.w * Math.pow(1 - Math.pow(f, N_SE), 1 / N_SE); };
  return { top, bot, wid, Lh, BULGE, warp, sec, sidePoint, capPoint, capEdge };
}

function bodyGeometry(sp, S) {
  const NX = 380, NT = 96, CAP = 8, st = [];
  for (let k = 0; k < CAP; k++) st.push([-S.Lh, Math.max(Math.sin((k / CAP) * Math.PI / 2), 0.002), -1]);
  for (let i = 0; i <= NX; i++) st.push([-S.Lh + (sp.L * i) / NX, 1, 0]);
  for (let k = CAP - 1; k >= 0; k--) st.push([S.Lh, Math.max(Math.sin((k / CAP) * Math.PI / 2), 0.002), 1]);
  const pos = [], idx = [], R = sp.wheelR + ARCH_GAP;
  for (const [x, s, end] of st) {
    const c = S.sec(x);
    for (let j = 0; j < NT; j++) {
      const th = -Math.PI / 2 + (j / NT) * Math.PI * 2;
      const z = c.w * spow(Math.cos(th), E) * s;
      let y = c.yc + c.hh * spow(Math.sin(th), E) * s;
      const X = S.warp(x + end * S.BULGE * (1 - s * s), x, z);
      if (Math.abs(z) > 0.5) for (const xa of [sp.axF, sp.axR]) {
        const dx = X - xa, lim = R * R - dx * dx;
        if (lim > 0 && y < sp.wheelR + Math.sqrt(lim)) y = sp.wheelR + Math.sqrt(lim);
      }
      pos.push(X, y, z);
    }
  }
  for (let i = 0; i < st.length - 1; i++) for (let j = 0; j < NT; j++) {
    const a = i * NT + j, b = (i + 1) * NT + j, a1 = i * NT + ((j + 1) % NT), b1 = (i + 1) * NT + ((j + 1) % NT);
    idx.push(a, b, a1, b, b1, a1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function greenhouseGeometry(sp, S) {
  const roof = curve1D(sp.roof), NX = 220, NP = 48, Eg = 2 / 3.0, pos = [], all = [], paint = [], glass = [];
  for (let i = 0; i <= NX; i++) {
    const x = sp.gx0 + ((sp.gx1 - sp.gx0) * i) / NX, yb = S.top(x) - 0.03, h = Math.max(roof(x) - yb, 0.002), wg = S.wid(x) - 0.07;
    for (let j = 0; j <= NP; j++) {
      const ph = (Math.PI * j) / NP;
      pos.push(x, yb + h * spow(Math.sin(ph), Eg), wg * spow(Math.cos(ph), Eg) * (1 - 0.14 * Math.sin(ph)));
    }
  }
  for (let i = 0; i < NX; i++) for (let j = 0; j < NP; j++) {
    const a = i * (NP + 1) + j, b = a + NP + 1, q = [a, b, a + 1, b, b + 1, a + 1];
    const x = sp.gx0 + ((sp.gx1 - sp.gx0) * (i + 0.5)) / NX, d = Math.abs((j + 0.5) / NP - 0.5);
    let isPaint;
    if (d < 0.23) isPaint = x > sp.roofX[0] && x < sp.roofX[1];
    else if (d < 0.275 && x > sp.roofX[0] - 0.3 && x < sp.roofX[1] + 0.4) isPaint = true;
    else isPaint = x > sp.sideGlassX[1] || x < sp.sideGlassX[0];
    all.push(...q); (isPaint ? paint : glass).push(...q);
  }
  const full = new THREE.BufferGeometry();
  full.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  full.setIndex(all);
  full.computeVertexNormals();
  const sub = (ix) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', full.getAttribute('position')); g.setAttribute('normal', full.getAttribute('normal')); g.setIndex(ix); return g; };
  return { full, paint: sub(paint), glass: sub(glass) };
}

/** Vertical band hugging the body along a polyline of surface points. */
function bandGeometry(pts, h, off) {
  const pos = [], uv = [], idx = [], n = pts.length;
  let len = 0;
  const cum = pts.map((p, i) => (i ? (len += p.distanceTo(pts[i - 1])) : 0));
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, n - 1)], p = pts[i];
    let nx = -(b.z - a.z), nz = b.x - a.x;
    const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
    if (nx * p.x + nz * p.z < 0) { nx = -nx; nz = -nz; }
    pos.push(p.x + nx * off, p.y - h / 2, p.z + nz * off, p.x + nx * off, p.y + h / 2, p.z + nz * off);
    uv.push(cum[i] / len, 0, cum[i] / len, 1);
  }
  for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function wrapLine(S, end, y, wrap) {
  const pts = [], zE = S.capEdge(end, y), x0 = end * S.Lh;
  for (let i = 10; i >= 1; i--) pts.push(S.sidePoint(x0 - end * (wrap * i) / 10, y, -1));
  for (let i = 0; i <= 40; i++) pts.push(S.capPoint(end, y, -zE + (2 * zE * i) / 40));
  for (let i = 1; i <= 10; i++) pts.push(S.sidePoint(x0 - end * (wrap * i) / 10, y, 1));
  return pts;
}

/** Patch on the nose/tail face. halfW(v) lets the outline taper; zc shifts it sideways. */
function capPatch(S, end, y0, y1, halfW, zc, off, nu = 24, nv = 6) {
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const v = j / nv, u = i / nu, y = y0 + (y1 - y0) * v, z = zc + (u * 2 - 1) * halfW(v);
    const p = S.capPoint(end, y, z);
    pos.push(p.x + end * off, p.y, p.z); uv.push(end > 0 ? 1 - u : u, v);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + nu + 1;
    if (end > 0) idx.push(a, a + 1, b, a + 1, b + 1, b); else idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const grilleTex = canvasTex(1024, 512, (g, w, h) => {
  g.fillStyle = '#020203'; g.fillRect(0, 0, w, h);
  const r = rng(7), cw = 34, ch = 22;
  for (let y = 0, row = 0; y < h + ch; y += ch, row++) for (let x = -cw; x < w + cw; x += cw) {
    const ox = x + (row % 2) * (cw / 2), b = 12 + Math.floor(r() * 30);
    g.fillStyle = `rgb(${b},${b + 2},${b + 6})`;
    g.beginPath(); g.moveTo(ox + 6, y + 3); g.lineTo(ox + cw - 3, y + 3); g.lineTo(ox + cw - 9, y + ch - 3); g.lineTo(ox, y + ch - 3); g.closePath(); g.fill();
  }
});
const shadowTex = canvasTex(256, 256, (g, w) => {
  const r = g.createRadialGradient(w / 2, w / 2, w * 0.18, w / 2, w / 2, w / 2);
  r.addColorStop(0, 'rgba(0,0,0,0.92)'); r.addColorStop(0.6, 'rgba(0,0,0,0.55)'); r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, w, w);
});
const badgeTex = canvasTex(512, 64, (g, w, h) => {
  g.clearRect(0, 0, w, h); g.fillStyle = '#e6e9ee'; g.font = '700 46px "Segoe UI", Arial'; g.textBaseline = 'middle'; g.textAlign = 'center';
  g.letterSpacing = '26px'; g.fillText('VERNA', w / 2 + 13, h / 2 + 3);
});

function buildWheel(r) {
  const grp = new THREE.Group(), spin = new THREE.Group();
  grp.add(spin);
  const prof = [[0.215, -0.105], [0.3, -0.108], [0.325, -0.09], [0.335, -0.05], [0.335, 0.05], [0.325, 0.09], [0.3, 0.108], [0.215, 0.105]].map(([a, b]) => new THREE.Vector2((a * r) / 0.335, b));
  const tire = new THREE.Mesh(new THREE.LatheGeometry(prof, 48).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x08090a, roughness: 0.85 }));
  spin.add(tire);
  const k = r / 0.335;
  const metal = new THREE.MeshStandardMaterial({ color: 0xc4c9d0, metalness: 1, roughness: 0.28 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0c0d10, metalness: 0.7, roughness: 0.5 });
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.218 * k, 0.218 * k, 0.2, 48, 1, true).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x1a1c20, metalness: 0.9, roughness: 0.45, side: THREE.DoubleSide }));
  const back = new THREE.Mesh(new THREE.CircleGeometry(0.218 * k, 40), dark); back.position.z = 0.0;
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.15 * k, 0.15 * k, 0.02, 40).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x6d7178, metalness: 1, roughness: 0.4 })); disc.position.z = 0.03;
  const lip = new THREE.Mesh(new THREE.TorusGeometry(0.218 * k, 0.009, 10, 64), metal); lip.position.z = 0.098;
  spin.add(barrel, back, disc, lip);
  for (let i = 0; i < 5; i++) for (const d of [-0.11, 0.11]) {
    const a = (i / 5) * Math.PI * 2 + d;
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.19 * k, 0.026, 0.022), metal);
    sp.position.set(Math.cos(a) * 0.125 * k, Math.sin(a) * 0.125 * k, 0.085); sp.rotation.z = a - d * 0.9; spin.add(sp);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.055, 0.03, 24).rotateX(Math.PI / 2), metal); hub.position.z = 0.092;
  spin.add(hub);
  return { grp, spin };
}

export function buildCar({ paint = 0xa2a8b0 } = {}) {
  const sp = VERNA, S = makeSurface(sp), group = new THREE.Group();
  const paintMat = new THREE.MeshPhysicalMaterial({ color: paint, metalness: 0.55, roughness: 0.36, clearcoat: 1, clearcoatRoughness: 0.2 });
  cladding(paintMat, sp, 0.3);
  const roofMat = new THREE.MeshPhysicalMaterial({ color: paint, metalness: 0.55, roughness: 0.36, clearcoat: 1, clearcoatRoughness: 0.2 });
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x04060a, metalness: 0.2, roughness: 0.07, clearcoat: 1, clearcoatRoughness: 0.03 });
  const bodyGeo = bodyGeometry(sp, S), gh = greenhouseGeometry(sp, S);
  const body = new THREE.Mesh(bodyGeo, paintMat);
  group.add(body, new THREE.Mesh(gh.paint, roofMat), new THREE.Mesh(gh.glass, glassMat));

  const wheels = [];
  for (const xa of [sp.axF, sp.axR]) for (const sg of [1, -1]) {
    const w = buildWheel(sp.wheelR);
    w.grp.position.set(xa, sp.wheelR, sg * sp.track);
    if (sg < 0) w.grp.rotation.y = Math.PI;
    w.sg = sg; group.add(w.grp); wheels.push(w);
  }
  const car = { group, spec: sp, S, wheels, body, lights: {}, flares: [] };
  car.setRoll = (dist) => { for (const w of wheels) w.spin.rotation.z = (-w.sg * dist) / sp.wheelR; };

  // mirrors, door seams, handles
  for (const sg of [1, -1]) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), roofMat);
    m.scale.set(0.055, 0.058, 0.105); m.position.set(sp.sideGlassX[1] + 0.1, S.top(0.7) + 0.075, sg * (S.wid(0.7) + 0.06)); m.rotation.y = sg * 0.25; group.add(m);
    const seamMat = new THREE.MeshBasicMaterial({ color: 0x050607 });
    for (const x of [sp.sideGlassX[1] + 0.02, (sp.sideGlassX[0] + sp.sideGlassX[1]) / 2 - 0.02, sp.sideGlassX[0] + 0.08]) {
      const pts = []; for (let i = 0; i <= 14; i++) { const y = 0.27 + ((S.top(x) - 0.06 - 0.27) * i) / 14; const p = S.sidePoint(x, y, sg); p.z += sg * 0.0015; pts.push(p); }
      const geo = new THREE.BufferGeometry(), pos = [], ix = [];
      pts.forEach((p, i) => { pos.push(p.x - 0.004, p.y, p.z, p.x + 0.004, p.y, p.z); if (i < pts.length - 1) { const a = i * 2; ix.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } });
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(ix);
      const seam = new THREE.Mesh(geo, seamMat); seam.material.side = THREE.DoubleSide; group.add(seam);
    }
    for (const x of [0.05, -0.85]) {
      const p = S.sidePoint(x, 0.86, sg), hd = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.022, 0.02), roofMat);
      hd.position.set(p.x, p.y, p.z + sg * 0.006); group.add(hd);
    }
  }
  const sh = new THREE.Mesh(new THREE.PlaneGeometry(sp.L + 1.3, sp.W + 1.1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.9 }));
  sh.position.y = 0.012; sh.renderOrder = 1; group.add(sh);

  const emit = (hex, k) => new THREE.MeshBasicMaterial({ color: hdr(hex, k), side: THREE.DoubleSide });
  const flare = (p, hex, size, k, fwd) => {
    const a = glowSprite(hex, size, k), b = glowSprite(hex, size * 4.2, k * 0.55, streakTex);
    a.position.copy(p); b.position.copy(p); a.userData.fwd = b.userData.fwd = fwd; group.add(a, b); car.flares.push(a, b); return [a, b];
  };

  // full-width horizon DRL, parametric grille, low-set headlamps
  car.lights.drl = emit(0xeaf3ff, 4.5);
  group.add(new THREE.Mesh(bandGeometry(wrapLine(S, 1, 0.618, 0.34), 0.02, 0.004), car.lights.drl));
  const grille = new THREE.Mesh(capPatch(S, 1, 0.295, 0.59, (v) => 0.47 + 0.115 * Math.sin(Math.PI * Math.min(v * 1.25, 1)), 0, 0.003, 40, 10), new THREE.MeshStandardMaterial({ map: grilleTex, metalness: 0.15, roughness: 0.55, envMapIntensity: 0.35, side: THREE.DoubleSide }));
  group.add(grille);
  car.lights.head = emit(0xfff4e0, 5);
  for (const sg of [1, -1]) {
    group.add(new THREE.Mesh(capPatch(S, 1, 0.445, 0.535, () => 0.07, sg * 0.56, 0.006, 6, 3), car.lights.head));
    flare(S.capPoint(1, 0.49, sg * 0.56).add(new THREE.Vector3(0.05, 0, 0)), 0xeaf2ff, 0.8, 0.7, 1);
  }
  // connected tail lamp: full-width bar with a drop at each corner
  car.lights.tail = emit(0xe60000, 1.55);
  group.add(new THREE.Mesh(bandGeometry(wrapLine(S, -1, 0.885, 0.3), 0.024, 0.004), car.lights.tail));
  for (const sg of [1, -1]) group.add(new THREE.Mesh(capPatch(S, -1, 0.66, 0.885, (v) => 0.016 + 0.012 * v, sg * 0.585, 0.005, 3, 8), car.lights.tail));
  flare(S.capPoint(-1, 0.885, 0).add(new THREE.Vector3(-0.05, 0, 0)), 0xff1a1a, 1.1, 0.3, -1);
  const plate = new THREE.Mesh(capPatch(S, -1, 0.5, 0.61, () => 0.26, 0, 0.003, 8, 2), new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.5, side: THREE.DoubleSide }));
  group.add(plate);
  const basis = (mesh, p) => { mesh.matrixAutoUpdate = false; mesh.matrix.makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0)).setPosition(p.x - 0.005, p.y, p.z); group.add(mesh); };
  basis(new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.0525), new THREE.MeshBasicMaterial({ map: badgeTex, transparent: true, color: 0xb9bec6 })), S.capPoint(-1, 0.705, 0));
  const fin = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.15, 12), glassMat); fin.rotation.z = 1.05; fin.scale.z = 0.45; fin.position.set(-1.0, 1.455, 0); group.add(fin);

  // red silhouette used to flag the threat
  const outMat = new THREE.ShaderMaterial({
    uniforms: { uT: { value: 0.022 }, uColor: { value: hdr(0xff3030, 3.2) }, uOn: { value: 0 } },
    vertexShader: 'uniform float uT; void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position + normal * uT, 1.0); }',
    fragmentShader: 'uniform vec3 uColor; uniform float uOn; void main(){ gl_FragColor = vec4(uColor * uOn, 1.0); }',
    side: THREE.BackSide,
  });
  const o1 = new THREE.Mesh(bodyGeo, outMat), o2 = new THREE.Mesh(gh.full, outMat);
  o1.visible = o2.visible = false; group.add(o1, o2);
  car.setOutline = (k) => { outMat.uniforms.uOn.value = k; o1.visible = o2.visible = k > 0.01; };

  const lampBase = Object.fromEntries(Object.entries(car.lights).map(([k, m]) => [k, m.color.clone()]));
  car.setLights = (k) => { for (const n in car.lights) car.lights[n].color.copy(lampBase[n]).multiplyScalar(k); };
  /** Fade lamp flares by how directly each lamp faces the camera. */
  const fw = new THREE.Vector3(), tc = new THREE.Vector3(), wp = new THREE.Vector3();
  car.updateFlares = (cam, gain = 1) => {
    fw.set(1, 0, 0).transformDirection(group.matrixWorld);
    for (const f of car.flares) {
      f.getWorldPosition(wp); tc.copy(cam.position).sub(wp).normalize();
      const facing = Math.max(tc.dot(fw) * f.userData.fwd, 0);
      f.material.color.copy(f.userData.base).multiplyScalar(Math.pow(facing, 1.6) * gain);
    }
  };
  return car;
}
