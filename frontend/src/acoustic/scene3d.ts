/**
 * three.js visualisation of the Acoustic Shield simulation.
 *
 * Purely a view: it reads simulation state and never feeds anything back into
 * the physics or decision pipeline. World (x east, y north) maps to three.js
 * (x, 0, -y); a heading θ maps to a rotation of θ about +Y.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildCar, type CarModel } from './carModel.js';
import { BUILDINGS } from './city.ts';
import { DEG } from './config.ts';
import type { ThreatLevel } from './decision.ts';
import { LANE_WIDTH, ROAD_HALF_WIDTH } from './scenarios.ts';
import type { AcousticShieldSimulation } from './simulation.ts';
import { corners, type Vec2, type VehicleState } from './vehicle.ts';

/** cinematic: elevated rear three-quarter view that keeps the Hyundai and the main threat in frame. */
export type CameraMode = 'cinematic' | 'chase' | 'orbit' | 'top';

export const LEVEL_COLORS: Record<ThreatLevel, string> = {
  NORMAL: '#3ec98a',
  WATCH: '#e3c14d',
  WARNING: '#ff9a3d',
  CRITICAL: '#ff4d57',
};

const TARGET_COLORS = ['#9c1d24', '#1f4f8f', '#c08a22', '#2f6a45', '#5d3f78'];
const EGO_COLOR = '#d4d8dd';
const SHIELD_COLOR = '#5cc8ff';
const TRACK_COLOR = '#5cc8ff';

const v3 = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- dynamic overlay primitives

class Ribbon {
  readonly mesh: THREE.Mesh;
  private positions: Float32Array;
  private max: number;

  constructor(maxPoints: number, color: string, opacity: number) {
    this.max = maxPoints;
    this.positions = new Float32Array(maxPoints * 2 * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    const index: number[] = [];
    for (let i = 0; i < maxPoints - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geom.setIndex(index);
    this.mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  update(points: Vec2[], width: number, height: number, color?: string) {
    const n = Math.min(points.length, this.max);
    if (color) (this.mesh.material as THREE.MeshBasicMaterial).color.set(color);
    this.mesh.visible = n >= 2;
    if (n < 2) return;
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const q = points[Math.min(n - 1, i + 1)];
      const o = points[Math.max(0, i - 1)];
      let dx = q.x - o.x;
      let dy = q.y - o.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const nx = -dy * width / 2;
      const ny = dx * width / 2;
      this.positions.set([p.x + nx, height, -(p.y + ny), p.x - nx, height, -(p.y - ny)], i * 6);
    }
    const geom = this.mesh.geometry;
    geom.attributes.position.needsUpdate = true;
    geom.setDrawRange(0, (n - 1) * 6);
    geom.computeBoundingSphere();
  }
}

class RectOutline {
  readonly line: THREE.LineLoop;
  private positions = new Float32Array(12);

  constructor(color: string, opacity = 1) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.line = new THREE.LineLoop(geom, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
    this.line.frustumCulled = false;
    this.line.renderOrder = 3;
  }

  update(s: Pick<VehicleState, 'x' | 'y' | 'heading' | 'length' | 'width'> | null, height = 0.08, color?: string) {
    this.line.visible = !!s;
    if (!s) return;
    if (color) (this.line.material as THREE.LineBasicMaterial).color.set(color);
    corners(s).forEach((c, i) => this.positions.set([c.x, height, -c.y], i * 3));
    this.line.geometry.attributes.position.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- vehicle model

interface VehicleView {
  car: CarModel;
  group: THREE.Group;
  tailBase: THREE.Color;
  roll: number;
}

// ---------------------------------------------------------------- scene

export class ShieldScene {
  onPick: (id: string | null) => void = () => {};
  private renderer: THREE.WebGLRenderer;
  private shieldWaves: THREE.Mesh[] = [];
  private shieldPower = 0;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private sun: THREE.DirectionalLight;
  private container: HTMLElement;
  private resizeObserver: ResizeObserver;
  private vehicles = new Map<string, VehicleView>();
  private mode: CameraMode = 'cinematic';
  private lastEgo: THREE.Vector3 | null = null;
  private camLook = new THREE.Vector3();
  private targetPaths = new Map<string, { path: Ribbon; truth: Ribbon; egoGhost: RectOutline; tgtGhost: RectOutline; trackBox: RectOutline; los: THREE.Line }>();
  private egoPath: Ribbon;
  private contactMarker: THREE.Mesh;
  private selectionRing: THREE.Mesh;
  private radar: THREE.Group;
  private radarFan: THREE.Mesh;
  private sweep: THREE.Mesh;
  private measurementDots: THREE.InstancedMesh;
  private pointerDown: { x: number; y: number } | null = null;
  private clock = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1500);
    this.camera.position.set(-80, 6, -2);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 220;
    this.controls.enabled = false;

    // Late-afternoon sky gradient; fog matches the horizon colour so the city fades into it.
    const skyCanvas = document.createElement('canvas');
    skyCanvas.width = 4;
    skyCanvas.height = 256;
    const sg = skyCanvas.getContext('2d')!;
    const grad = sg.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#5f86b8');
    grad.addColorStop(0.55, '#a9c1da');
    grad.addColorStop(1, '#e4d9c8');
    sg.fillStyle = grad;
    sg.fillRect(0, 0, 4, 256);
    const skyTex = new THREE.CanvasTexture(skyCanvas);
    skyTex.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = skyTex;
    this.scene.environment = this.outdoorEnv();
    this.scene.environmentIntensity = 0.9;
    this.scene.fog = new THREE.Fog('#d6d6d0', 140, 560);
    this.scene.add(new THREE.HemisphereLight('#dfe9f5', '#4b4f45', 0.9));
    this.sun = new THREE.DirectionalLight('#ffe9cf', 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 10; sc.far = 320;
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target);

    this.buildEnvironment();

    this.egoPath = new Ribbon(80, EGO_COLOR, 0.55);
    this.scene.add(this.egoPath.mesh);

    this.contactMarker = new THREE.Mesh(new THREE.RingGeometry(0.7, 1.1, 40), new THREE.MeshBasicMaterial({ color: LEVEL_COLORS.CRITICAL, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    this.contactMarker.rotation.x = -Math.PI / 2;
    this.contactMarker.renderOrder = 4;
    this.scene.add(this.contactMarker);

    this.selectionRing = new THREE.Mesh(new THREE.RingGeometry(3.1, 3.35, 56), new THREE.MeshBasicMaterial({ color: '#8fc1ff', transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
    this.selectionRing.rotation.x = -Math.PI / 2;
    this.selectionRing.renderOrder = 3;
    this.scene.add(this.selectionRing);

    this.radar = new THREE.Group();
    this.radarFan = new THREE.Mesh(new THREE.CircleGeometry(1, 72), new THREE.MeshBasicMaterial({ color: '#4fa8ff', transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide }));
    this.radarFan.rotation.x = -Math.PI / 2;
    this.radar.add(this.radarFan);
    for (const r of [25, 50, 75, 100, 125, 150]) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r - 0.08, r + 0.08, 128), new THREE.MeshBasicMaterial({ color: '#7cc0ff', transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.userData.radius = r;
      this.radar.add(ring);
    }
    this.sweep = new THREE.Mesh(new THREE.CircleGeometry(1, 24, 0, 10 * DEG), new THREE.MeshBasicMaterial({ color: '#7cc0ff', transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }));
    this.sweep.rotation.x = -Math.PI / 2;
    this.radar.add(this.sweep);
    this.radar.position.y = 0.05;
    this.radar.renderOrder = 1;
    this.scene.add(this.radar);

    this.measurementDots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color: TRACK_COLOR }), 32);
    this.measurementDots.count = 0;
    this.measurementDots.frustumCulled = false;
    this.scene.add(this.measurementDots);

    // Expanding rings around the Hyundai while the shield is active (visual cue only).
    for (let i = 0; i < 3; i++) {
      const wave = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color(SHIELD_COLOR), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      wave.rotation.x = -Math.PI / 2;
      wave.renderOrder = 5;
      wave.visible = false;
      this.shieldWaves.push(wave);
      this.scene.add(wave);
    }


    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.handleDown);
    el.addEventListener('pointerup', this.handleUp);
  }

  // ---------------------------------------------------------------- static world

  /** Sky-dome reflection map (blue zenith, bright horizon, dark street, a hot sun spot) so paint reads as outdoors. */
  private outdoorEnv() {
    const env = new THREE.Scene();
    const geo = new THREE.SphereGeometry(50, 48, 24);
    const col: number[] = [];
    const pos = geo.getAttribute('position');
    const sky = new THREE.Color('#4f79b0'), horizon = new THREE.Color('#e9e4da'), ground = new THREE.Color('#3a3d40'), c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 50;
      if (y >= 0) c.copy(horizon).lerp(sky, Math.pow(y, 0.6)); else c.copy(horizon).lerp(ground, Math.min(1, -y * 6));
      col.push(c.r * 1.3, c.g * 1.3, c.b * 1.3);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    env.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    const sun = new THREE.Mesh(new THREE.SphereGeometry(3, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color('#fff1dc').multiplyScalar(6) }));
    sun.position.set(30, 32, 20);
    env.add(sun);
    const pm = new THREE.PMREMGenerator(this.renderer);
    const tex = pm.fromScene(env, 0.02).texture;
    pm.dispose();
    geo.dispose();
    return tex;
  }

  private buildEnvironment() {
    const add = (o: THREE.Object3D) => { this.scene.add(o); return o; };
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), new THREE.MeshStandardMaterial({ color: '#5d6655', roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    add(ground);

    const asphalt = new THREE.MeshStandardMaterial({ color: '#2c2f34', roughness: 0.92 });
    const roadW = 2 * ROAD_HALF_WIDTH + 1;
    for (const [w, d] of [[1600, roadW], [roadW, 1600]]) {
      const road = new THREE.Mesh(new THREE.PlaneGeometry(w, d), asphalt);
      road.rotation.x = -Math.PI / 2;
      road.position.y = 0.02;
      road.receiveShadow = true;
      add(road);
    }

    // Sidewalks / curbs in the four quadrants.
    const kerb = new THREE.MeshStandardMaterial({ color: '#8d9198', roughness: 0.95 });
    const e = ROAD_HALF_WIDTH + 0.5;
    const walk = 4;
    const far = 800;
    for (const sx of [1, -1]) for (const sy of [1, -1]) {
      for (const [cx, cy, w, d] of [
        [sx * (e + far / 2), sy * (e + walk / 2), far, walk],
        [sx * (e + walk / 2), sy * (e + far / 2), walk, far],
      ]) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, d), kerb);
        b.position.copy(v3(cx, cy, 0.08));
        b.receiveShadow = true;
        add(b);
      }
    }

    // Lane markings: instanced quads.
    const white: THREE.Matrix4[] = [];
    const yellow: THREE.Matrix4[] = [];
    const stripe = (list: THREE.Matrix4[], x: number, y: number, len: number, wid: number, alongX: boolean) => {
      const m = new THREE.Matrix4().compose(v3(x, y, 0.035), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2), new THREE.Vector3(alongX ? len : wid, alongX ? wid : len, 1));
      list.push(m);
    };
    const gap = e + walk; // keep markings out of the junction and crosswalks
    for (const along of [true, false]) {
      for (const sgn of [1, -1]) {
        const from = gap + 2;
        const to = 450;
        const mid = (from + to) / 2;
        const len = to - from;
        const place = (lat: number, list: THREE.Matrix4[], w: number, dashed: boolean) => {
          if (dashed) {
            for (let s = from; s < to; s += 9) stripe(list, along ? sgn * (s + 1.5) : lat, along ? lat : sgn * (s + 1.5), 3, w, along);
          } else stripe(list, along ? sgn * mid : lat, along ? lat : sgn * mid, len, w, along);
        };
        place(0.15, yellow, 0.12, false);
        place(-0.15, yellow, 0.12, false);
        place(LANE_WIDTH, white, 0.13, true);
        place(-LANE_WIDTH, white, 0.13, true);
        place(ROAD_HALF_WIDTH - 0.2, white, 0.15, false);
        place(-ROAD_HALF_WIDTH + 0.2, white, 0.15, false);
      }
    }
    // Zebra crossings and stop lines.
    for (const sgn of [1, -1]) {
      for (let k = -ROAD_HALF_WIDTH + 0.6; k < ROAD_HALF_WIDTH; k += 1.2) {
        stripe(white, sgn * (e + 2), k, 3, 0.6, true);
        stripe(white, k, sgn * (e + 2), 3, 0.6, false);
      }
    }
    stripe(white, -(gap + 1.2), ROAD_HALF_WIDTH / 2, 0.4, ROAD_HALF_WIDTH, true);
    stripe(white, gap + 1.2, -ROAD_HALF_WIDTH / 2, 0.4, ROAD_HALF_WIDTH, true);
    stripe(white, ROAD_HALF_WIDTH / 2, gap + 1.2, 0.4, ROAD_HALF_WIDTH, false);
    stripe(white, -ROAD_HALF_WIDTH / 2, -(gap + 1.2), 0.4, ROAD_HALF_WIDTH, false);
    const quad = new THREE.PlaneGeometry(1, 1);
    for (const [list, color] of [[white, '#e9ecef'], [yellow, '#e5b93a']] as const) {
      const inst = new THREE.InstancedMesh(quad, new THREE.MeshStandardMaterial({ color, roughness: 0.7 }), list.length);
      list.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.receiveShadow = true;
      add(inst);
    }

    // Buildings come from the shared city map (city.ts) the radar line-of-sight model also uses.
    const facade = ['#9a9c9f', '#b3aa9c', '#7f858c', '#c2bdb4', '#8e8a84', '#a6aeb6'].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }));
    const windowMat = new THREE.MeshStandardMaterial({ color: '#3b4654', roughness: 0.3, metalness: 0.4 });
    for (const bld of BUILDINGS) {
      const { cx, cy, w: bw, d: bd, h, alongX, sx, sy, s } = bld;
      const b = new THREE.Mesh(new THREE.BoxGeometry(bw, h, bd), facade[bld.facade]);
      b.position.copy(v3(cx, cy, h / 2));
      b.castShadow = s < 160;
      b.receiveShadow = true;
      add(b);
      // Window bands on the street-facing side (near blocks only, to bound draw calls).
      for (let fy = 3; s < 160 && fy < h - 1; fy += 3.2) {
        const band = new THREE.Mesh(new THREE.BoxGeometry(alongX ? bw * 0.86 : 0.05, 1.3, alongX ? 0.05 : bw * 0.86), windowMat);
        const face = alongX ? v3(cx, cy - sy * (bd / 2 + 0.03), fy) : v3(cx - sx * (bw / 2 + 0.03), cy, fy);
        band.position.copy(face);
        add(band);
      }
    }
    const rand = mulberry(11);
    const trunks: THREE.Matrix4[] = [];
    const crowns: THREE.Matrix4[] = [];
    for (const sx of [1, -1]) for (const sy of [1, -1]) for (const alongX of [true, false]) {
      for (let s = e + walk + 5; s < 300; s += 16) {
        const lat = e + walk - 1;
        const p = alongX ? v3(sx * s, sy * lat, 0) : v3(sx * lat, sy * s, 0);
        const scale = 0.8 + rand() * 0.5;
        trunks.push(new THREE.Matrix4().compose(p.clone().setY(1.3 * scale), new THREE.Quaternion(), new THREE.Vector3(scale, scale, scale)));
        crowns.push(new THREE.Matrix4().compose(p.clone().setY(3.6 * scale), new THREE.Quaternion(), new THREE.Vector3(scale, scale * 1.15, scale)));
      }
    }
    const trunkMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.2, 2.6, 6), new THREE.MeshStandardMaterial({ color: '#5a4636' }), trunks.length);
    trunks.forEach((m, i) => trunkMesh.setMatrixAt(i, m));
    trunkMesh.castShadow = true;
    const crownMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.7, 1), new THREE.MeshStandardMaterial({ color: '#3e5b3a', roughness: 0.95, flatShading: true }), crowns.length);
    crowns.forEach((m, i) => crownMesh.setMatrixAt(i, m));
    crownMesh.castShadow = true;
    add(trunkMesh);
    add(crownMesh);

    // Signal poles at the junction corners.
    const pole = new THREE.MeshStandardMaterial({ color: '#3a3d42', metalness: 0.6, roughness: 0.5 });
    const head = new THREE.MeshStandardMaterial({ color: '#1b1d20' });
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 5.5, 8), pole);
      p.position.copy(v3(sx * (e + 1), sy * (e + 1), 2.75));
      p.castShadow = true;
      add(p);
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.0, 0.35), head);
      h.position.copy(v3(sx * (e + 1), sy * (e + 1), 5.0));
      add(h);
    }
  }

  // ---------------------------------------------------------------- interaction

  private handleDown = (e: PointerEvent) => {
    this.pointerDown = { x: e.clientX, y: e.clientY };
  };

  private handleUp = (e: PointerEvent) => {
    const start = this.pointerDown;
    this.pointerDown = null;
    if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const groups = [...this.vehicles.values()].map((v) => v.group);
    const hit = ray.intersectObjects(groups, true)[0];
    let obj: THREE.Object3D | null = hit?.object ?? null;
    while (obj && obj.userData.vehicleId === undefined) obj = obj.parent;
    this.onPick(obj ? (obj.userData.vehicleId as string) : null);
  };

  setCameraMode(mode: CameraMode) {
    this.mode = mode;
    this.controls.enabled = mode === 'orbit';
    this.lastEgo = null;
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- per-frame update

  private vehicleView(v: VehicleState, index: number): VehicleView {
    let view = this.vehicles.get(v.id);
    if (view) return view;
    const color = v.kind === 'ego' ? EGO_COLOR : TARGET_COLORS[index % TARGET_COLORS.length];
    const car = buildCar({ paint: color });
    car.setLights(0.45); // daytime: running lamps lit, not glaring
    const group = new THREE.Group();
    group.add(car.group);
    group.userData.vehicleId = v.id;
    car.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry.type !== 'PlaneGeometry') m.castShadow = true;
    });
    this.scene.add(group);
    view = { car, group, tailBase: car.lights.tail.color.clone(), roll: 0 };
    this.vehicles.set(v.id, view);
    return view;
  }

  private overlaysFor(id: string) {
    let o = this.targetPaths.get(id);
    if (!o) {
      const losGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      o = {
        path: new Ribbon(80, LEVEL_COLORS.NORMAL, 0.7),
        truth: new Ribbon(80, '#ffffff', 0.25),
        egoGhost: new RectOutline(EGO_COLOR, 0.95),
        tgtGhost: new RectOutline(LEVEL_COLORS.CRITICAL, 0.95),
        trackBox: new RectOutline(TRACK_COLOR, 0.95),
        los: new THREE.Line(losGeom, new THREE.LineBasicMaterial({ color: TRACK_COLOR, transparent: true, opacity: 0.45, depthTest: false })),
      };
      o.los.frustumCulled = false;
      this.scene.add(o.path.mesh, o.truth.mesh, o.egoGhost.line, o.tgtGhost.line, o.trackBox.line, o.los);
      this.targetPaths.set(id, o);
    }
    return o;
  }

  render(sim: AcousticShieldSimulation, opts: { dt: number; selectedId: string | null; showTruth: boolean; showRadar: boolean }) {
    this.clock += opts.dt;
    const alpha = sim.interpolationAlpha;
    const pose = (v: VehicleState) => {
      const p = sim.prevPoses.get(v.id);
      if (!p) return { x: v.x, y: v.y, heading: v.heading };
      const dh = Math.atan2(Math.sin(v.heading - p.heading), Math.cos(v.heading - p.heading));
      return { x: p.x + (v.x - p.x) * alpha, y: p.y + (v.y - p.y) * alpha, heading: p.heading + dh * alpha };
    };

    // Vehicles.
    const all = [sim.ego, ...sim.targets];
    const live = new Set(all.map((v) => v.id));
    const levelOf = new Map(sim.assessment.targets.map((t) => [t.targetId, t.level]));
    all.forEach((v, i) => {
      const view = this.vehicleView(v, i - 1);
      // The model is authored at Verna size; stretch it to the simulated footprint (also follows live size edits).
      view.car.group.scale.set(v.length / view.car.spec.L, 1, v.width / view.car.spec.W);
      const p = pose(v);
      const prev = view.group.position.clone();
      view.group.position.copy(v3(p.x, p.y));
      view.group.rotation.y = p.heading;
      view.roll += Math.min(5, prev.distanceTo(view.group.position));
      view.car.setRoll(view.roll);
      const braking = v.accel < -1 && v.speed > 0.1;
      view.car.lights.tail.color.copy(view.tailBase).multiplyScalar(braking ? 3.2 : 1);
      const lvl = levelOf.get(v.id);
      view.car.setOutline(lvl === 'CRITICAL' ? 0.65 + 0.35 * Math.sin(this.clock * 10) : lvl === 'WARNING' ? 0.4 : 0);
    });
    for (const [id, view] of this.vehicles) if (!live.has(id)) { this.disposeObject(view.group); this.vehicles.delete(id); }

    // Per-target overlays.
    const tracked = new Map(sim.trackViews.map((v) => [v.track.objectId, v]));
    for (const [id, o] of this.targetPaths) {
      if (!live.has(id) || id === 'ego') {
        this.scene.remove(o.path.mesh, o.truth.mesh, o.egoGhost.line, o.tgtGhost.line, o.trackBox.line, o.los);
        this.targetPaths.delete(id);
      }
    }
    let primaryContact: Vec2 | null = null;
    const primaryId = sim.assessment.primary?.targetId ?? null;
    for (const t of sim.targets) {
      const o = this.overlaysFor(t.id);
      const pred = sim.predictions.get(t.id);
      const truth = sim.truthPredictions.get(t.id);
      const color = LEVEL_COLORS[levelOf.get(t.id) ?? 'NORMAL'];
      if (pred) o.path.update(pred.targetPath, 0.45, 0.06, color);
      else o.path.mesh.visible = false;
      if (opts.showTruth && truth) o.truth.update(truth.targetPath, 0.16, 0.07);
      else o.truth.mesh.visible = false;
      const contact = pred?.collision && pred.ttc !== null && pred.ttc > 0;
      o.egoGhost.update(contact ? pred!.egoAtContact : null, 0.1);
      o.tgtGhost.update(contact ? pred!.targetAtContact : null, 0.1, color);
      if (contact && t.id === primaryId) primaryContact = pred!.contactPoint;
      const tv = tracked.get(t.id);
      o.trackBox.update(tv ? tv.state : null, 0.12, tv && tv.confidence > 0 ? TRACK_COLOR : '#7d8794');
      o.los.visible = !!tv && opts.showRadar;
      if (tv) {
        const pos = o.los.geometry.attributes.position as THREE.BufferAttribute;
        pos.setXYZ(0, sim.ego.x, 0.6, -sim.ego.y);
        pos.setXYZ(1, tv.state.x, 0.6, -tv.state.y);
        pos.needsUpdate = true;
      }
    }
    const primaryPred = primaryId ? sim.predictions.get(primaryId) : undefined;
    if (primaryPred) this.egoPath.update(primaryPred.egoPath, 0.45, 0.055);
    else this.egoPath.mesh.visible = false;

    this.contactMarker.visible = !!primaryContact;
    if (primaryContact) {
      this.contactMarker.position.copy(v3(primaryContact.x, primaryContact.y, 0.12));
      const s = 1 + 0.25 * Math.sin(this.clock * 8);
      this.contactMarker.scale.set(s, s, s);
    }

    // Selection ring.
    const sel = all.find((v) => v.id === opts.selectedId);
    this.selectionRing.visible = !!sel;
    if (sel) {
      const p = pose(sel);
      this.selectionRing.position.copy(v3(p.x, p.y, 0.09));
      const r = Math.max(sel.length, sel.width) / 4.6;
      this.selectionRing.scale.set(r, r, r);
    }

    // Radar coverage and raw measurements.
    const ego = pose(sim.ego);
    const sensor = sim.config.sensor;
    this.radar.visible = opts.showRadar;
    this.radar.position.set(ego.x, 0.05, -ego.y);
    this.radar.rotation.y = ego.heading;
    const fov = Math.min(360, sensor.fovDeg) * DEG;
    if ((this.radarFan.userData.key as string) !== `${fov}:${sensor.maxRangeM}`) {
      this.radarFan.geometry.dispose();
      this.radarFan.geometry = new THREE.CircleGeometry(sensor.maxRangeM, 96, -fov / 2, fov);
      this.radarFan.userData.key = `${fov}:${sensor.maxRangeM}`;
    }
    for (const child of this.radar.children) {
      if (child.userData.radius) child.visible = child.userData.radius <= sensor.maxRangeM + 0.1;
    }
    this.sweep.scale.setScalar(sensor.maxRangeM);
    this.sweep.rotation.z = fov >= 2 * Math.PI - 1e-6 ? -this.clock * 2.4 : -fov / 2 + ((this.clock * 0.6) % 1) * (fov - 10 * DEG);
    const dot = new THREE.Matrix4();
    let n = 0;
    if (opts.showRadar) {
      for (const m of sim.lastMeasurements) {
        if (n >= 32 || !Number.isFinite(m.range)) continue;
        const b = m.egoPose.heading + m.azimuth;
        dot.makeTranslation(m.egoPose.x + m.range * Math.cos(b), 0.6, -(m.egoPose.y + m.range * Math.sin(b)));
        this.measurementDots.setMatrixAt(n++, dot);
      }
    }
    this.measurementDots.count = n;
    this.measurementDots.instanceMatrix.needsUpdate = true;

    // Shield rings.
    this.shieldPower += ((sim.protection.state === 'ACTIVE' ? 1 : 0) - this.shieldPower) * (1 - Math.exp(-opts.dt * 6));
    this.shieldWaves.forEach((w, i) => {
      const phase = (this.clock * 0.9 + i / this.shieldWaves.length) % 1;
      w.visible = this.shieldPower > 0.01;
      w.position.set(ego.x, 0.15, -ego.y);
      w.scale.setScalar(2.6 + phase * 13);
      (w.material as THREE.MeshBasicMaterial).opacity = (1 - phase) * 0.85 * this.shieldPower;
    });

    // Camera.
    const threat = sim.targets.find((t) => t.id === primaryId)
      ?? sim.targets.reduce<VehicleState | null>((best, t) => (!best || Math.hypot(t.x - sim.ego.x, t.y - sim.ego.y) < Math.hypot(best.x - sim.ego.x, best.y - sim.ego.y) ? t : best), null);
    this.updateCamera(ego, opts.dt, threat ? pose(threat) : null);
    this.sun.position.set(ego.x + 60, 90, -ego.y + 40);
    this.sun.target.position.set(ego.x, 0, -ego.y);
    this.scene.updateMatrixWorld();
    for (const v of this.vehicles.values()) v.car.updateFlares(this.camera, 0.12);
    this.renderer.render(this.scene, this.camera);
  }

  private updateCamera(ego: { x: number; y: number; heading: number }, dt: number, threat: { x: number; y: number } | null) {
    const egoPos = v3(ego.x, ego.y);
    const fwd = new THREE.Vector3(Math.cos(ego.heading), 0, -Math.sin(ego.heading));
    const k = 1 - Math.exp(-dt * 5);
    if (this.mode === 'cinematic') {
      // Stay over the Hyundai's own road (buildings line it) and look across to the threat: camera behind the
      // car, or ahead of it when the threat comes from behind.
      const d = threat ? v3(threat.x, threat.y).sub(egoPos) : null;
      const sep = d ? d.length() : 0;
      const near = !!d && sep > 0.5 && sep < 160;
      const ahead = near && d!.dot(fwd) < -0.3 * sep ? -1 : 1;
      // Low and close so the Hyundai fills the lower third; pulls back a little as the threat closes in.
      const dist = near ? THREE.MathUtils.clamp(10.5 + (40 - Math.min(sep, 40)) * 0.12, 10.5, 15) : 10.5;
      // Aim just ahead of the car; swing toward the threat only once it is within ~60 m.
      const w = near ? THREE.MathUtils.clamp((60 - sep) / 40, 0, 1) : 0;
      const look = egoPos.clone().addScaledVector(fwd, 4 * (1 - w)).setY(0.9);
      if (near) look.addScaledVector(d!, (Math.min(sep, 25) / sep) * 0.5 * w);
      const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
      const desired = egoPos.clone().addScaledVector(fwd, -ahead * dist).addScaledVector(right, ahead * 1.8).setY(2.6 + dist * 0.28);
      const kc = 1 - Math.exp(-dt * 2.2);
      if (!this.lastEgo) { this.camera.position.copy(desired); this.camLook.copy(look); }
      else { this.camera.position.lerp(desired, kc); this.camLook.lerp(look, kc); }
      this.camera.lookAt(this.camLook);
    } else if (this.mode === 'chase') {
      const desired = egoPos.clone().addScaledVector(fwd, -11).setY(4.3);
      if (!this.lastEgo) this.camera.position.copy(desired);
      else this.camera.position.lerp(desired, k);
      this.camera.lookAt(egoPos.clone().addScaledVector(fwd, 8).setY(1.2));
    } else if (this.mode === 'top') {
      const desired = egoPos.clone().addScaledVector(fwd, 18).setY(95);
      desired.z += 0.01;
      if (!this.lastEgo) this.camera.position.copy(desired);
      else this.camera.position.lerp(desired, k);
      this.camera.lookAt(egoPos.clone().addScaledVector(fwd, 18));
    } else {
      if (this.lastEgo) {
        const delta = egoPos.clone().sub(this.lastEgo);
        this.camera.position.add(delta);
        this.controls.target.add(delta);
      } else {
        this.controls.target.copy(egoPos).setY(1);
      }
      this.controls.update();
    }
    this.lastEgo = egoPos;
  }

  private disposeObject(obj: THREE.Object3D) {
    this.scene.remove(obj);
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
  }

  dispose() {
    this.resizeObserver.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.handleDown);
    el.removeEventListener('pointerup', this.handleUp);
    this.controls.dispose();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else (mat as THREE.Material | undefined)?.dispose();
    });
    this.renderer.dispose();
    el.remove();
  }
}
