import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { Sky } from "./vendor/Sky.js";

const NS = "org.openegiz.pit";

// Keep in sync with constants.py / generate_twins.py.
const THING_IDS = [
  "section-01", "shift-01",
  "face-ore-01", "face-ore-02", "face-waste-01",
  "excavator-01", "excavator-02", "excavator-03",
  "truck-01", "truck-02", "truck-03", "truck-04", "truck-05", "truck-06",
  "road-face1", "road-face2", "road-main-a", "road-main-b", "road-waste",
  "junction-01", "stockpile-01", "crusher-01", "conveyor-01", "dump-01", "fuel-01", "repair-01",
];
const TRUCK_IDS = THING_IDS.filter((id) => id.startsWith("truck-"));
const EXCAVATOR_IDS = ["excavator-01", "excavator-02", "excavator-03"];
const EXCAVATOR_FACE = { "excavator-01": "face-ore-01", "excavator-02": "face-ore-02", "excavator-03": "face-waste-01" };
const ROAD_IDS = ["road-face1", "road-face2", "road-main-a", "road-main-b", "road-waste"];

// Schematic layout (meters, arbitrary scale) -- geometry is not sourced,
// see SUBMISSION.md -> Concept, so this is deliberately stylized, not a
// claim about Aktogay's real layout.
const NODE_POSITIONS = {
  "face-ore-01": [-45, 0, -55], "face-ore-02": [45, 0, -55],
  "junction-01": [0, 0, -15],
  "crusher-01": [0, 0, 35], "stockpile-01": [28, 0, 42], "conveyor-01": [0, 0, 60],
  "fuel-01": [18, 0, -12], "repair-01": [62, 0, -10],
  "face-waste-01": [-72, 0, 15], "dump-01": [-80, 0, 60],
};
// road-main-b bows out from a straight line so it reads as a visibly
// different, longer detour, not an overlap of road-main-a.
const ROAD_BEND = { "road-main-b": [22, 0, 12] };

const STATE_COLOR = {
  idle: 0x8b96a3, active: 0x3fb950, loading: 0xd29922, hauling: 0x58a6ff, returning: 0x3fb950,
  dumping: 0xd29922, queued_at_excavator: 0x8b96a3, queued_at_crusher: 0x8b96a3, crushing: 0x3fb950,
  queued_stockpile_full: 0xe5534b, blocked_road: 0xe5534b, blocked_at_junction: 0xe5534b, blocked: 0xe5534b,
  waiting_excavator_down: 0xe5534b, down: 0xe5534b, refueling: 0xa371f7, serving: 0xa371f7,
  open: 0x3fb950, closed: 0xe5534b, busy: 0xd29922, running: 0x3fb950, stopped: 0x8b96a3,
};
const colorFor = (state) => STATE_COLOR[state] ?? 0x8b96a3;

// Simulated seconds per real second -- needed to extrapolate truck motion
// smoothly between SSE ticks (see updateTruckMotion). Default matches the
// simulator's own default (SIM_SPEEDUP=10); corrected from section-01's own
// telemetry once bootstrap() returns, so this only matters for the first
// couple of frames.
let SPEEDUP = 10;

// ---------------------------------------------------------------------------
// Data layer: bootstrap over REST, then live updates over SSE.
// ---------------------------------------------------------------------------

const world = {}; // shortId -> { attributes, features }
const shortId = (thingId) => (thingId.startsWith(NS + ":") ? thingId.slice(NS.length + 1) : thingId);

async function bootstrap(retries = 20) {
  const ids = THING_IDS.map((id) => `${NS}:${id}`).join(",");
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(`/ditto/api/2/things?ids=${encodeURIComponent(ids)}&fields=thingId,attributes,features`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const things = await res.json();
      for (const t of things) world[shortId(t.thingId)] = { attributes: t.attributes || {}, features: t.features || {} };
      return;
    } catch (err) {
      console.warn("bootstrap attempt failed, retrying", err);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error("could not bootstrap twin state from Ditto");
}

function connectSSE() {
  const url = `/ditto/api/2/things?namespaces=${encodeURIComponent(NS)}&fields=thingId,attributes,features`;
  const es = new EventSource(url);
  es.onmessage = (ev) => {
    if (!ev.data) return; // Ditto sends empty keep-alive frames between real updates
    try {
      const t = JSON.parse(ev.data);
      if (!t.thingId) return;
      const id = shortId(t.thingId);
      const prev = world[id] || { attributes: {}, features: {} };
      world[id] = {
        attributes: { ...prev.attributes, ...(t.attributes || {}) },
        features: t.features ? { ...prev.features, ...t.features } : prev.features,
      };
    } catch (err) {
      console.warn("bad SSE payload", err);
    }
  };
  // EventSource reconnects on its own; a persistent error just means the
  // scene free-runs on last-known state until the stream comes back.
  es.onerror = () => {};
  return es;
}

const fval = (id, feature) => world[id]?.features?.[feature]?.properties?.value;
const aval = (id, attr) => world[id]?.attributes?.[attr];

async function writeFeature(id, feature, value) {
  const res = await fetch(`/ditto/api/2/things/${NS}:${id}/features/${feature}/properties/value`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!res.ok) console.error("write failed", id, feature, res.status, await res.text().catch(() => ""));
}

// ---------------------------------------------------------------------------
// Three.js scene
// ---------------------------------------------------------------------------

const container = document.getElementById("scene");
const scene = new THREE.Scene();

// Camera far plane has to clear the sky dome (see setupSky) or the dome is
// frustum-culled and nothing is drawn where the sky should be. near/far are
// kept as tight as that allows: depth precision depends on far/near, and the
// old 0.1 / 500000 (1:5,000,000) left ~1cm of depth resolution at 150m, so
// road stripes, pads and bench edges z-fought ("textures breaking") as the
// camera moved. 0.5 / 60000 is ~25x finer.
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.5, 60000);
camera.position.set(90, 95, 140);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(-5, 0, 0);
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 30;
controls.maxDistance = 400;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.update();

// ---------------------------------------------------------------------------
// Sky, sun and an image-based environment baked from the sky itself, so
// MeshStandardMaterial/MeshPhysicalMaterial have something real to reflect
// instead of flat ambient. Low golden-hour sun -- long shadows, warm light,
// fits an open-pit-in-the-steppe mood better than a neutral midday sky.
// ---------------------------------------------------------------------------

const SUN_ELEVATION_DEG = 9;
const SUN_AZIMUTH_DEG = 145;
const sunDirection = new THREE.Vector3().setFromSphericalCoords(
  1,
  THREE.MathUtils.degToRad(90 - SUN_ELEVATION_DEG),
  THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG),
);

function setupSky() {
  const sky = new Sky();
  // Box half-size 30000: corners (~52000) stay inside the camera far plane
  // (60000), and it still encloses the whole ground plane (half-size 20000).
  sky.scale.setScalar(60000);
  const u = sky.material.uniforms;
  u.turbidity.value = 8;
  u.rayleigh.value = 1.2;
  u.mieCoefficient.value = 0.009;
  u.mieDirectionalG.value = 0.88;
  u.sunPosition.value.copy(sunDirection);

  // Bake a PMREM environment from the sky alone (a scene of its own, not the
  // main one -- baking the whole scene would turn the ground/trucks into
  // reflection sources too). Sky is then reparented into the main scene for
  // visible rendering; Object3D.add() moves it, it cannot be in both.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const bakeScene = new THREE.Scene();
  bakeScene.add(sky);
  scene.environment = pmrem.fromScene(bakeScene, 0.03).texture;
  scene.add(sky);
  pmrem.dispose();
}
setupSky();

scene.fog = new THREE.Fog(0xcf9d74, 160, 480);

const sun = new THREE.DirectionalLight(0xffc896, 2.2);
// Shadow frustum centered on the pit/junction area (where the actual
// content is), not world origin -- target first, light offset from *that*.
sun.target.position.set(0, 0, -20);
sun.position.copy(sunDirection).multiplyScalar(220).add(sun.target.position);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -150;
sun.shadow.camera.right = 150;
sun.shadow.camera.top = 150;
sun.shadow.camera.bottom = -150;
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 420;
sun.shadow.bias = -0.0015;
scene.add(sun);
scene.add(sun.target);

// Sky-tint fill so shadowed faces aren't pure black; the environment map
// above already carries most of the ambient color now, this just softens it.
scene.add(new THREE.HemisphereLight(0xbfd4e8, 0x33281d, 0.4));

// ---------------------------------------------------------------------------
// Terrain: textured steppe floor with a real hole cut where the pit is, a
// terraced pit bowl with a pit lake, and scattered boulders.
// All of it is schematic -- not a claim about Aktogay's real geometry (see
// SUBMISSION.md -> Concept).
// ---------------------------------------------------------------------------

// Deterministic PRNG: procedural rocks/hills look the same on every reload
// (and on the judge's machine) instead of reshuffling each time.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(25);

// Position hash in [-1, 1]. Vertices that share a position (seams, the
// duplicated corners of non-indexed polyhedra) get the same offset, so
// roughened meshes don't crack open along their seams.
function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

// Push every vertex in/out along its own direction from the origin by a
// position-hashed amount -- turns a smooth primitive into a rock.
function roughen(geo, amp, { keepBelowY = -Infinity } = {}) {
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    if (v.y <= keepBelowY) continue;
    const k = 1 + amp * hash3(v.x, v.y, v.z);
    pos.setXYZ(i, v.x * k, v.y * (1 + amp * 0.5 * hash3(v.z, v.x, v.y)), v.z * k);
  }
  geo.computeVertexNormals();
  return geo;
}

function makeGroundTexture() {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#3a3429";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 2600; i++) {
    const x = rand() * size, y = rand() * size, r = 3 + rand() * 20;
    const shade = 0.7 + rand() * 0.55;
    ctx.fillStyle = `rgba(${Math.floor(70 * shade)},${Math.floor(62 * shade)},${Math.floor(46 * shade)},${0.15 + rand() * 0.2})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// The pit sits south of the ore faces, so the faces read as working the pit
// rim instead of floating over a hole. (The previous bowl was built under the
// ground plane and was never actually visible.)
const PIT_CENTER = { x: 0, z: -88 };
const PIT_RIM_R = 46;

function buildGround() {
  // Far bigger than the fog distance, so the floor fades into haze at the
  // true horizon instead of ending in a visible square edge.
  const half = 20000;
  const shape = new THREE.Shape();
  shape.moveTo(-half, -half); shape.lineTo(half, -half); shape.lineTo(half, half); shape.lineTo(-half, half); shape.closePath();
  const hole = new THREE.Path();
  // Shape Y becomes world -Z after the -90deg X rotation below.
  hole.absarc(PIT_CENTER.x, -PIT_CENTER.z, PIT_RIM_R, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const tex = makeGroundTexture();
  tex.repeat.set(1 / 34, 1 / 34); // ShapeGeometry UVs are raw coordinates
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape, 72), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.05;
  mesh.receiveShadow = true;
  return mesh;
}
scene.add(buildGround());

function buildPit() {
  const group = new THREE.Group();
  const { x: cx, z: cz } = PIT_CENTER;
  const wallMats = [
    new THREE.MeshStandardMaterial({ color: 0x6f5d47, roughness: 1, flatShading: true, side: THREE.DoubleSide }),
    new THREE.MeshStandardMaterial({ color: 0x5e4f3c, roughness: 1, flatShading: true, side: THREE.DoubleSide }),
  ];
  const benchMat = new THREE.MeshStandardMaterial({ color: 0x51463a, roughness: 1, side: THREE.DoubleSide });
  const LEVELS = 3, DROP = 7, WALL_IN = 5, BENCH = 6;
  let r = PIT_RIM_R, y = 0;
  for (let i = 0; i < LEVELS; i++) {
    const rBottom = r - WALL_IN;
    const geo = new THREE.CylinderGeometry(r, rBottom, DROP, 72, 3, true);
    // Rugged face: only interior rows move, so the top/bottom rings still
    // meet the benches exactly. Angle-based offsets keep the seam closed.
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k);
      if (Math.abs(Math.abs(v.y) - DROP / 2) < 1e-3) continue;
      const a = Math.atan2(v.z, v.x);
      const n = 1 + 0.035 * Math.sin(a * 13 + v.y * 1.7 + i) + 0.025 * Math.sin(a * 29 - v.y + i * 3);
      pos.setXYZ(k, v.x * n, v.y, v.z * n);
    }
    geo.computeVertexNormals();
    const wall = new THREE.Mesh(geo, wallMats[i % 2]);
    wall.position.set(cx, y - DROP / 2, cz);
    wall.receiveShadow = true;
    group.add(wall);
    y -= DROP;
    r = rBottom;
    if (i < LEVELS - 1) {
      const bench = new THREE.Mesh(new THREE.RingGeometry(r - BENCH, r, 72), benchMat);
      bench.rotation.x = -Math.PI / 2;
      bench.position.set(cx, y, cz);
      bench.receiveShadow = true;
      group.add(bench);
      r -= BENCH;
    }
  }
  const floor = new THREE.Mesh(new THREE.CircleGeometry(r, 72), benchMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, y, cz);
  floor.receiveShadow = true;
  group.add(floor);

  // Copper pits collect blue-green water at the bottom.
  const lake = new THREE.Mesh(
    new THREE.CircleGeometry(r * 0.6, 48),
    new THREE.MeshPhysicalMaterial({ color: 0x2f7377, roughness: 0.06, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05 }),
  );
  lake.rotation.x = -Math.PI / 2;
  lake.position.set(cx + 3, y + 0.06, cz + 2);
  group.add(lake);
  return group;
}
scene.add(buildPit());

// Static copy of generate_twins.py road_edges. Used ONLY to place scenery
// (excavators, muck piles, boulders) at load time -- the live road graph
// still comes from each road twin's attributes.from/to (see roadWaypoints).
const STATIC_ROAD_EDGES = [
  ["face-ore-01", "junction-01"], ["face-ore-02", "junction-01"],
  ["junction-01", "crusher-01"], ["face-waste-01", "dump-01"],
];
function distToSegment(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[2] - a[2];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[2]) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(px - (a[0] + dx * t), pz - (a[2] + dz * t));
}
function isClearGround(x, z) {
  if (Math.hypot(x - PIT_CENTER.x, z - PIT_CENTER.z) < PIT_RIM_R + 4) return false;
  for (const p of Object.values(NODE_POSITIONS)) if (Math.hypot(x - p[0], z - p[2]) < 20) return false;
  for (const [a, b] of STATIC_ROAD_EDGES) if (distToSegment(x, z, NODE_POSITIONS[a], NODE_POSITIONS[b]) < 7) return false;
  if (distToSegment(x, z, [0, 0, -15], ROAD_BEND["road-main-b"]) < 7) return false;
  if (distToSegment(x, z, ROAD_BEND["road-main-b"], [0, 0, 35]) < 7) return false;
  if (Math.abs(x) < 6 && z > 30 && z < 115) return false; // conveyor line
  return true;
}

// One InstancedMesh = one draw call for every boulder in the scene.
function buildBoulders() {
  const COUNT = 260;
  const mesh = new THREE.InstancedMesh(
    roughen(new THREE.IcosahedronGeometry(1, 1), 0.22),
    new THREE.MeshStandardMaterial({ color: 0x75685a, roughness: 1, flatShading: true }),
    COUNT,
  );
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const p = new THREE.Vector3(), s = new THREE.Vector3();
  let n = 0;
  while (n < COUNT) {
    const x = (rand() - 0.5) * 380, z = (rand() - 0.5) * 380 - 10;
    if (!isClearGround(x, z)) continue;
    const size = 0.25 + Math.pow(rand(), 3) * 1.8;
    p.set(x, size * 0.25, z);
    q.setFromEuler(e.set(rand() * 3, rand() * 3, rand() * 3));
    s.set(size * (0.8 + rand() * 0.5), size * (0.5 + rand() * 0.3), size * (0.8 + rand() * 0.5));
    mesh.setMatrixAt(n++, m.compose(p, q, s));
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
scene.add(buildBoulders());


// ---------------------------------------------------------------------------
// Drifting dust -- cheap atmosphere, one draw call for the whole field.
// ---------------------------------------------------------------------------

function makeGlowTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.4, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}
const glowTexture = makeGlowTexture();

const DUST_COUNT = 420;
const DUST_BOUNDS = 150;
function buildDust() {
  const positions = new Float32Array(DUST_COUNT * 3);
  const drift = new Float32Array(DUST_COUNT); // per-particle speed + phase packed as speed only; phase derived from index
  for (let i = 0; i < DUST_COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * DUST_BOUNDS * 2;
    positions[i * 3 + 1] = Math.random() * 16 + 0.3;
    positions[i * 3 + 2] = (Math.random() - 0.5) * DUST_BOUNDS * 2 - 20;
    drift[i] = 0.35 + Math.random() * 0.9;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.55, map: glowTexture, color: 0xd8c6a3, transparent: true, opacity: 0.28,
    depthWrite: false, sizeAttenuation: true, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.userData.drift = drift;
  points.frustumCulled = false;
  scene.add(points);
  return points;
}
const dust = buildDust();

function animateDust(dtS) {
  const pos = dust.geometry.attributes.position;
  const drift = dust.userData.drift;
  for (let i = 0; i < DUST_COUNT; i++) {
    let x = pos.getX(i) + drift[i] * dtS;
    if (x > DUST_BOUNDS) x -= DUST_BOUNDS * 2;
    pos.setX(i, x);
    pos.setY(i, pos.getY(i) + Math.sin((performance.now() / 1000 + i) * 0.6) * 0.0025);
  }
  pos.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Status beacons: a glowing marker + soft sprite + small point light at any
// fixed-position object that is currently down/closed -- the point of a
// what-if demo is that the consequence should be visible across the scene,
// not just in a side panel.
// ---------------------------------------------------------------------------

const beacons = {};
function createBeacon(pos, color = 0xff4433) {
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.45, 14, 14),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }),
  );
  sphere.position.set(pos[0], pos[1], pos[2]);
  sphere.visible = false;
  scene.add(sphere);

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  glow.position.copy(sphere.position);
  glow.scale.set(6, 6, 1);
  glow.visible = false;
  scene.add(glow);

  const light = new THREE.PointLight(color, 0, 24, 2);
  light.position.copy(sphere.position);
  scene.add(light);

  return { sphere, glow, light };
}

function updateBeacon(key, active, nowMs) {
  const b = beacons[key];
  if (!b) return;
  b.sphere.visible = active;
  b.glow.visible = active;
  if (!active) { b.light.intensity = 0; return; }
  const pulse = 0.5 + 0.5 * Math.sin(nowMs / 260);
  b.sphere.material.opacity = 0.55 + 0.4 * pulse;
  b.glow.scale.setScalar(5 + pulse * 2.4);
  b.glow.material.opacity = 0.3 + 0.5 * pulse;
  b.light.intensity = 5 + pulse * 11;
}

// ---------------------------------------------------------------------------
// Procedural 3D models. Everything is built from Three.js primitives at load
// time -- no glTF files to vendor, works offline on the judge's machine.
// Each pickable object is a Group with userData.id; the parts whose color
// tracks twin state are listed in userData.colorMats (see setGroupColor).
// ---------------------------------------------------------------------------

function makeStripeTexture({ base, line, every = 16, width = 5, size = 128, horizontal = false, repeat = [1, 1] }) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = line;
  for (let o = 0; o < size; o += every) {
    if (horizontal) ctx.fillRect(0, o, size, width); else ctx.fillRect(o, 0, width, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(...repeat);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Conveyor belt surface: dark rubber with ore lumps. Each belt gets its own
// clone so its repeat can match its length; offset is animated while running.
function makeBeltTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64; canvas.height = 256;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#1c1d20";
  ctx.fillRect(0, 0, 64, 256);
  for (let i = 0; i < 160; i++) {
    const shade = 70 + Math.floor(rand() * 60);
    ctx.fillStyle = `rgb(${shade + 20},${shade + 8},${shade - 10})`;
    ctx.beginPath();
    ctx.arc(10 + rand() * 44, rand() * 256, 1.5 + rand() * 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const beltTexBase = makeBeltTexture();

const MAT = {
  paint: new THREE.MeshPhysicalMaterial({ color: 0xe0a32a, roughness: 0.42, metalness: 0.25, clearcoat: 0.6, clearcoatRoughness: 0.3 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x8a929b, roughness: 0.4, metalness: 0.75 }),
  steelDark: new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.6, metalness: 0.55 }),
  steelDarkDouble: new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.6, metalness: 0.55, side: THREE.DoubleSide }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.15, metalness: 1 }),
  tire: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, map: makeStripeTexture({ base: "#18191c", line: "#0a0a0c", every: 8, width: 4, repeat: [3, 1] }) }),
  tireWall: new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: 0.85 }),
  hub: new THREE.MeshStandardMaterial({ color: 0xc4c9cf, roughness: 0.35, metalness: 0.8 }),
  track: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.4, map: makeStripeTexture({ base: "#2a2b2e", line: "#121314", every: 16, width: 6, repeat: [1, 6] }) }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0x1f3242, roughness: 0.05, metalness: 0.3, clearcoat: 1, envMapIntensity: 1.8 }),
  grille: new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.6, metalness: 0.4 }),
  headlight: new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xffe9a8, emissiveIntensity: 1.4, roughness: 0.3 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0xa39d93, roughness: 0.95 }),
  white: new THREE.MeshStandardMaterial({ color: 0xe6e6e1, roughness: 0.55, metalness: 0.1 }),
  cladding: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.4, map: makeStripeTexture({ base: "#c4cbd3", line: "#939ca6", every: 16, width: 5, repeat: [6, 1] }) }),
  claddingDouble: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.4, side: THREE.DoubleSide, map: makeStripeTexture({ base: "#b6bec6", line: "#88919b", every: 16, width: 5, repeat: [12, 3] }) }),
  tank: new THREE.MeshStandardMaterial({ color: 0xd9dcdf, roughness: 0.35, metalness: 0.6 }),
  ore: new THREE.MeshStandardMaterial({ color: 0x6b5d47, roughness: 1, flatShading: true }),
  // Copper-sulphide ore: greyer/greener than the waste rock, so ore and waste
  // piles are told apart by color alone.
  orePile: new THREE.MeshStandardMaterial({ color: 0x5f5e48, roughness: 1, flatShading: true }),
  waste: new THREE.MeshStandardMaterial({ color: 0x8a7c69, roughness: 1, flatShading: true }),
  gravel: new THREE.MeshStandardMaterial({ color: 0x75685a, roughness: 1 }),
  berm: new THREE.MeshStandardMaterial({ color: 0x5f5242, roughness: 1, flatShading: true }),
  lampRed: new THREE.MeshStandardMaterial({ color: 0xff4433, emissive: 0xff2a1a, emissiveIntensity: 1.5 }),
  lampAmber: new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0xff9900, emissiveIntensity: 0.4 }),
  lampGreen: new THREE.MeshStandardMaterial({ color: 0x3fdc5a, emissive: 0x22cc44, emissiveIntensity: 1.5 }),
  lampWhite: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2cc, emissiveIntensity: 2 }),
};

// Paint that follows twin state (setGroupColor writes .color).
const stateMat = (hex = 0x8b96a3, opts = {}) =>
  new THREE.MeshPhysicalMaterial({ color: hex, roughness: 0.45, metalness: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.3, ...opts });
// Glowing status lamp/stripe: setGroupColor also writes .emissive for these.
function glowMat(hex = 0x8b96a3, intensity = 1.2) {
  const m = new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: intensity, roughness: 0.4 });
  m.userData.glow = true;
  return m;
}

const boxG = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cylG = (rt, rb, h, seg = 16) => new THREE.CylinderGeometry(rt, rb, h, seg);
function part(geo, mat, x = 0, y = 0, z = 0, parent = null, shadow = true) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  if (parent) parent.add(m);
  return m;
}
// Mesh aligned so its local Y runs from a to b (cylinders, struts, rams).
function strut(a, b, radius, mat, parent, seg = 8) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const m = part(cylG(radius, radius, dir.length(), seg), mat, 0, 0, 0, parent);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

function makeLabel(text) {
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(14,17,22,0.75)";
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(2, 6, 252, 52, 12); else ctx.rect(2, 6, 252, 52);
  ctx.fill();
  ctx.font = "bold 28px -apple-system, sans-serif"; ctx.fillStyle = "#d8dee6";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(14, 3.5, 1);
  sprite.renderOrder = 10;
  return sprite;
}

const pickables = []; // { mesh, id } -- mesh is a Group; raycast is recursive, see findPickableId
const nodeMeshes = {}; // id -> Group

function addNode(id, label, group, labelY) {
  const [x, , z] = NODE_POSITIONS[id];
  group.position.set(x, 0, z);
  group.userData.id = id;
  scene.add(group);
  const sprite = makeLabel(label);
  sprite.position.set(x, labelY, z);
  scene.add(sprite);
  pickables.push({ mesh: group, id });
  nodeMeshes[id] = group;
  return group;
}

// Unit XZ direction from one point to another, as [x, z].
function dirXZ(from, to) {
  const dx = to[0] - from[0], dz = to[2] - from[2];
  const len = Math.hypot(dx, dz) || 1;
  return [dx / len, dz / len];
}
const headingOf = ([dx, dz]) => Math.atan2(dx, dz); // rotation.y that points local +Z along (dx, dz)
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ---------------------------------------------------------------------------
// Working faces + excavator layout. For each face: trucks load AT the face
// node (where its road ends), the excavator stands beside that spot, and the
// blasted muck pile lies past the road's end. The excavator digs the pile,
// swings to the truck, dumps, swings back (see animateExcavator).
// ---------------------------------------------------------------------------

const FACE_EXIT = { "face-ore-01": "junction-01", "face-ore-02": "junction-01", "face-waste-01": "dump-01" };
const EXC_SIDE_SIGN = { "excavator-01": -1, "excavator-02": 1, "excavator-03": -1 }; // which side of the road, away from the busy middle
const EXC_LAYOUT = {};
for (const exc of EXCAVATOR_IDS) {
  const face = EXCAVATOR_FACE[exc];
  const F = NODE_POSITIONS[face];
  const u = dirXZ(F, NODE_POSITIONS[FACE_EXIT[face]]); // along the road, away from the face
  const n = [u[1] * EXC_SIDE_SIGN[exc], -u[0] * EXC_SIDE_SIGN[exc]]; // perpendicular, toward the excavator
  const pos = [F[0] + n[0] * 8.5, 0, F[2] + n[1] * 8.5];
  const pile = [pos[0] - u[0] * 8.5, 0, pos[2] - u[1] * 8.5];
  const facing = headingOf([-u[0], -u[1]]); // excavator faces the pile
  const swing = wrapAngle(headingOf([-n[0], -n[1]]) - facing); // turret angle that points at the truck
  EXC_LAYOUT[exc] = { face, u, n, pos, pile, facing, swing };
}

function buildFaceMesh(exc, isOre) {
  const L = EXC_LAYOUT[exc];
  const F = NODE_POSITIONS[L.face];
  const group = new THREE.Group();
  const rockMat = isOre ? MAT.orePile : MAT.waste;
  const px = L.pile[0] - F[0], pz = L.pile[2] - F[2];

  // Blasted muck pile: a roughened, squashed dome plus loose boulders.
  const dome = part(roughen(new THREE.SphereGeometry(6, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0.16, { keepBelowY: 0.01 }), rockMat, px, 0, pz, group);
  dome.scale.set(1, 0.5, 1);
  const chunks = new THREE.InstancedMesh(roughen(new THREE.IcosahedronGeometry(1, 0), 0.2), rockMat, 26);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  for (let i = 0; i < 26; i++) {
    const a = rand() * Math.PI * 2, r = 3 + rand() * 5;
    const size = 0.4 + rand() * 0.9;
    p.set(px + Math.cos(a) * r, size * 0.4 + Math.max(0, 2.2 - r * 0.3), pz + Math.sin(a) * r);
    q.setFromEuler(e.set(rand() * 3, rand() * 3, rand() * 3));
    chunks.setMatrixAt(i, m.compose(p, q, s.set(size, size * 0.7, size)));
  }
  chunks.castShadow = chunks.receiveShadow = true;
  group.add(chunks);

  // Bench highwall behind the pile.
  const wallGeo = roughen(new THREE.BoxGeometry(18, 6, 4, 14, 5, 2), 0.06);
  const wall = part(wallGeo, rockMat, px - L.u[0] * 7, 2.6, pz - L.u[1] * 7, group);
  wall.rotation.y = headingOf(L.u);

  // Status flag (state-colored) + a mobile light tower for the night shift.
  const flagMat = stateMat(isOre ? 0x3fb950 : 0x8b96a3, { clearcoat: 0 });
  const fx = px + L.n[0] * 7, fz = pz + L.n[1] * 7;
  part(cylG(0.08, 0.08, 6, 6), MAT.steel, fx, 3, fz, group);
  part(boxG(0.05, 1, 1.8), flagMat, fx, 5.4, fz + 0.9, group);
  const tx = -L.n[0] * 7 - L.u[0] * 3, tz = -L.n[1] * 7 - L.u[1] * 3;
  part(boxG(1.4, 0.9, 2.4), MAT.paint, tx, 0.75, tz, group);
  part(cylG(0.1, 0.12, 7, 8), MAT.steel, tx, 4.5, tz, group);
  part(boxG(1.8, 0.5, 0.3), MAT.steelDark, tx, 8.1, tz, group);
  for (const ox of [-0.55, 0, 0.55]) part(boxG(0.4, 0.3, 0.05), MAT.lampWhite, tx + ox, 8.1, tz + 0.18, group, false);

  group.userData.colorMats = [flagMat];
  return group;
}

addNode("face-ore-01", "Забой-1", buildFaceMesh("excavator-01", true), 11);
addNode("face-ore-02", "Забой-2", buildFaceMesh("excavator-02", true), 11);
addNode("face-waste-01", "Уступ вскрыши", buildFaceMesh("excavator-03", false), 11);

// ---------------------------------------------------------------------------
// Hydraulic face shovel: crawlers, carbody, slewing house with counterweight
// and cab, boom -> stick -> bucket with teeth and rams. House paint follows
// state; turret/boom/stick/bucket are articulated for the loading cycle.
// Local +Z is forward.
// ---------------------------------------------------------------------------

const BOOM_REST = -0.55, STICK_REST = 1.35, BUCKET_REST = 0.3;
function buildExcavatorMesh() {
  const group = new THREE.Group();
  const houseMat = stateMat();

  for (const sx of [-1, 1]) {
    const track = new THREE.Group();
    track.position.x = sx * 1.85;
    group.add(track);
    part(boxG(1.1, 1.0, 4.6), MAT.track, 0, 0.62, 0, track);
    for (const ez of [-2.3, 2.3]) part(cylG(0.62, 0.62, 1.1, 18), MAT.track, 0, 0.62, ez, track).rotation.z = Math.PI / 2;
    for (const rz of [-2.3, -1.15, 0, 1.15, 2.3]) {
      part(cylG(0.3, 0.3, 0.08, 12), MAT.steel, sx * 0.58, 0.62, rz, track, false).rotation.z = Math.PI / 2;
    }
  }
  part(boxG(2.8, 0.8, 3.0), MAT.steelDark, 0, 1.2, 0, group);
  part(cylG(1.5, 1.5, 0.35, 24), MAT.steel, 0, 1.75, 0, group);

  const turret = new THREE.Group();
  turret.position.y = 1.92;
  group.add(turret);
  part(boxG(3.4, 1.7, 4.4), houseMat, 0, 0.85, -0.7, turret);
  part(boxG(3.6, 1.3, 1.0), MAT.steelDark, 0, 0.75, -3.35, turret);
  part(boxG(3.45, 0.08, 4.45), MAT.steelDark, 0, 1.74, -0.7, turret, false);
  part(boxG(1.35, 1.45, 1.45), MAT.paint, -1.0, 2.45, 1.15, turret);
  part(boxG(1.2, 0.75, 0.04), MAT.glass, -1.0, 2.7, 1.89, turret, false);
  part(boxG(0.04, 0.75, 1.1), MAT.glass, -1.69, 2.7, 1.15, turret, false);
  for (const ex of [0.6, 1.1]) part(cylG(0.12, 0.12, 0.9, 8), MAT.steelDark, ex, 2.15, -1.9, turret);
  for (const rx of [-1.65, 1.65]) part(boxG(0.05, 0.05, 4.2), MAT.steel, rx, 2.25, -0.7, turret, false); // handrails

  const boomPivot = new THREE.Group();
  boomPivot.position.set(0.35, 1.5, 1.3);
  turret.add(boomPivot);
  part(boxG(0.75, 0.85, 5.0), MAT.paint, 0, 0, 2.5, boomPivot);
  // boom rams: from the house deck up to the boom's underside
  for (const rx of [-0.5, 0.5]) strut(new THREE.Vector3(rx, -1.2, 0.2), new THREE.Vector3(rx, -0.3, 2.6), 0.13, MAT.chrome, boomPivot);

  const stickPivot = new THREE.Group();
  stickPivot.position.set(0, 0, 4.9);
  boomPivot.add(stickPivot);
  part(boxG(0.55, 0.6, 3.4), MAT.paint, 0, 0, 1.7, stickPivot);
  strut(new THREE.Vector3(0, 0.55, -1.6), new THREE.Vector3(0, 0.45, 0.6), 0.11, MAT.chrome, stickPivot);

  const bucket = new THREE.Group();
  bucket.position.set(0, 0, 3.4);
  stickPivot.add(bucket);
  part(boxG(2.1, 0.12, 1.6), MAT.steelDark, 0, -0.75, 0.6, bucket);
  part(boxG(2.1, 1.5, 0.12), MAT.steelDark, 0, 0, -0.2, bucket);
  for (const sx of [-1, 1]) part(boxG(0.12, 1.5, 1.6), MAT.steelDark, sx * 1.0, 0, 0.6, bucket);
  for (let i = 0; i < 5; i++) {
    part(new THREE.ConeGeometry(0.1, 0.4, 6), MAT.steel, -0.8 + i * 0.4, -0.75, 1.55, bucket, false).rotation.x = Math.PI / 2;
  }

  group.userData.colorMats = [houseMat];
  group.userData.rig = { turret, boomPivot, stickPivot, bucket };
  group.userData.pose = { s: 0, b: BOOM_REST, k: STICK_REST, c: BUCKET_REST };
  applyExcavatorPose(group);
  return group;
}

function applyExcavatorPose(group) {
  const { turret, boomPivot, stickPivot, bucket } = group.userData.rig;
  const p = group.userData.pose;
  turret.rotation.y = p.s;
  boomPivot.rotation.x = p.b;
  stickPivot.rotation.x = p.k;
  bucket.rotation.x = p.c;
}

// One loading cycle as keyframes: dig -> swing to truck -> dump -> swing back.
// s = turret swing (fraction of the angle to the truck), b = boom, k = stick, c = bucket curl.
const EXC_CYCLE_S = 7;
const EXC_KEYS = [
  [0.00, { s: 0, b: -0.28, k: 1.95, c: 0.1 }],
  [0.22, { s: 0, b: -0.38, k: 1.35, c: 1.05 }],
  [0.42, { s: 1, b: -0.68, k: 1.25, c: 1.05 }],
  [0.56, { s: 1, b: -0.68, k: 1.45, c: -0.5 }],
  [0.80, { s: 0, b: -0.5, k: 1.7, c: 0.2 }],
  [1.00, { s: 0, b: -0.28, k: 1.95, c: 0.1 }],
];
const smooth = (t) => t * t * (3 - 2 * t);
function excavatorCyclePose(t, swing) {
  let i = 0;
  while (i < EXC_KEYS.length - 2 && t > EXC_KEYS[i + 1][0]) i++;
  const [t0, a] = EXC_KEYS[i], [t1, b] = EXC_KEYS[i + 1];
  const f = smooth(Math.min(1, Math.max(0, (t - t0) / (t1 - t0))));
  const lerp = (x, y) => x + (y - x) * f;
  return { s: lerp(a.s, b.s) * swing, b: lerp(a.b, b.b), k: lerp(a.k, b.k), c: lerp(a.c, b.c) };
}
function animateExcavator(group, loading, nowMs, dtS) {
  const target = loading
    ? excavatorCyclePose(((nowMs / 1000) / EXC_CYCLE_S + group.userData.phase) % 1, group.userData.swing)
    : { s: 0, b: BOOM_REST, k: STICK_REST, c: BUCKET_REST };
  const p = group.userData.pose;
  const a = 1 - Math.exp(-dtS * 6); // ease in/out of the cycle instead of snapping
  for (const key of ["s", "b", "k", "c"]) p[key] += (target[key] - p[key]) * a;
  applyExcavatorPose(group);
}

EXCAVATOR_IDS.forEach((id, i) => {
  const L = EXC_LAYOUT[id];
  const mesh = buildExcavatorMesh();
  mesh.position.set(L.pos[0], 0, L.pos[2]);
  mesh.rotation.y = L.facing;
  mesh.userData.id = id;
  mesh.userData.swing = L.swing;
  mesh.userData.phase = i * 0.37;
  scene.add(mesh);
  const label = makeLabel(id);
  label.position.set(L.pos[0], 9.5, L.pos[2]);
  scene.add(label);
  pickables.push({ mesh, id });
  nodeMeshes[id] = mesh;
  beacons[id] = createBeacon([L.pos[0], 8.5, L.pos[2]]);
});

// ---------------------------------------------------------------------------
// Crusher: tipping pad, hopper block, clad crusher house with a state-colored
// band and roof lamp, stair tower. Trucks arrive from -Z and back up to the
// hopper.
// ---------------------------------------------------------------------------

function buildCrusherMesh() {
  const group = new THREE.Group();
  const accent = stateMat(0xd29922, { clearcoat: 0.2 });
  const lamp = glowMat(0xd29922, 1.6);

  part(boxG(14, 0.4, 9), MAT.concrete, 0, 0.2, -10, group); // top 0.4: clear of the road surface (0.3) and stripes
  part(boxG(12, 2.6, 5.5), MAT.concrete, 0, 1.3, -4.2, group);
  part(new THREE.CylinderGeometry(3.6, 1.4, 2.4, 4, 1, true), MAT.steelDarkDouble, 0, 1.45, -4.2, group).rotation.y = Math.PI / 4;
  part(boxG(8, 0.7, 0.7), MAT.concrete, 0, 0.35, -7.3, group); // wheel stop

  part(boxG(9, 10, 8), MAT.cladding, 0, 5, 2.5, group);
  part(boxG(9.1, 0.8, 8.1), accent, 0, 9.0, 2.5, group, false);
  part(boxG(9.12, 0.7, 5), MAT.glass, 0, 6.6, 2.5, group, false);
  const roofShape = new THREE.Shape();
  roofShape.moveTo(-4.8, 0); roofShape.lineTo(4.8, 0); roofShape.lineTo(0, 1.8); roofShape.closePath();
  part(new THREE.ExtrudeGeometry(roofShape, { depth: 8.4, bevelEnabled: false }), MAT.steelDark, 0, 10, -1.7, group);
  part(new THREE.SphereGeometry(0.5, 16, 10), lamp, 0, 12.1, 2.5, group, false);

  // Stair tower: four posts and landings.
  for (const [x, z] of [[5.2, -0.5], [7.6, -0.5], [5.2, 1.9], [7.6, 1.9]]) part(cylG(0.1, 0.1, 10.5, 6), MAT.paint, x, 5.25, z, group);
  for (const y of [3.5, 7, 10.4]) part(boxG(2.6, 0.12, 2.6), MAT.steel, 6.4, y, 0.7, group);

  group.userData.colorMats = [accent, lamp];
  return group;
}
addNode("crusher-01", "Дробилка", buildCrusherMesh(), 15.5);
beacons["crusher-01"] = createBeacon([NODE_POSITIONS["crusher-01"][0], 14, NODE_POSITIONS["crusher-01"][2]]);

// ---------------------------------------------------------------------------
// Conveyors: truss stringers + animated belt + support bents.
// ---------------------------------------------------------------------------

const belts = []; // { tex, speed, isRunning() }
function buildConveyorSpan(S, E, frameMat, parent, bentEvery = 9, width = 1.9) {
  const dir = new THREE.Vector3().subVectors(E, S);
  const L = dir.length();
  const truss = new THREE.Group();
  truss.position.copy(S).addScaledVector(dir, 0.5);
  truss.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
  parent.add(truss);
  for (const sx of [-1, 1]) part(boxG(0.22, 0.85, L), frameMat, sx * (width / 2 + 0.2), 0, 0, truss);
  const tex = beltTexBase.clone();
  tex.repeat.set(1, L / 5);
  tex.needsUpdate = true;
  part(boxG(width, 0.12, L), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }), 0, 0.32, 0, truss);
  part(boxG(0.8, 0.05, L), MAT.steel, width / 2 + 0.9, -0.3, 0, truss, false); // walkway
  const bents = Math.max(1, Math.floor(L / bentEvery));
  for (let i = 1; i < bents; i++) {
    const p = new THREE.Vector3().lerpVectors(S, E, i / bents);
    const h = p.y - 0.45;
    if (h < 0.5) continue;
    for (const sx of [-1, 1]) part(cylG(0.13, 0.17, h, 8), MAT.steel, p.x + sx * width * 0.55, h / 2, p.z, parent);
    part(boxG(width * 1.3, 0.2, 0.25), MAT.steel, p.x, h, p.z, parent);
  }
  return tex;
}

function buildConveyorMesh() {
  const group = new THREE.Group();
  const frameMat = stateMat(0x8b96a3, { clearcoat: 0 });
  // Local coords: group sits at the conveyor node; the belt starts inside the
  // crusher house and climbs off toward the (off-scene) concentrator.
  const S = new THREE.Vector3(0, 6, -22), E = new THREE.Vector3(0, 15, 48);
  const tex = buildConveyorSpan(S, E, frameMat, group);
  // head transfer house on stilts
  part(boxG(5, 4.5, 5), MAT.cladding, 0, E.y + 0.8, E.z + 2, group);
  part(boxG(5.1, 0.5, 5.1), frameMat, 0, E.y + 3.2, E.z + 2, group, false);
  for (const [x, z] of [[-2.2, 0], [2.2, 0], [-2.2, 4], [2.2, 4]]) part(cylG(0.18, 0.18, E.y - 1.4, 8), MAT.steel, x, (E.y - 1.4) / 2, E.z + z, group);
  group.userData.colorMats = [frameMat];
  belts.push({ tex, speed: 0.6, isRunning: () => fval("conveyor-01", "state") === "running" });
  return group;
}
addNode("conveyor-01", "Конвейер", buildConveyorMesh(), 13.5);

// ---------------------------------------------------------------------------
// Ore stockpile (grows with tonnes_current) fed by a radial stacker, and the
// terraced waste dump (rises with fill vs capacity).
// ---------------------------------------------------------------------------

function buildStockpileMesh() {
  const group = new THREE.Group();
  const pile = new THREE.Group();
  group.add(pile);
  // Smooth, slightly concave angle-of-repose profile (a lathe, not a noisy
  // cone -- per-vertex noise on a smooth-shaded cone reads as speckle).
  const profile = [];
  for (let i = 0; i <= 9; i++) {
    const t = i / 10;
    profile.push(new THREE.Vector2(3.6 * Math.pow(1 - t, 1.2), 2.8 * t));
  }
  profile.push(new THREE.Vector2(0.12, 2.68), new THREE.Vector2(0, 2.72)); // rounded crest
  const pileGeo = new THREE.LatheGeometry(profile, 48);
  part(pileGeo, new THREE.MeshStandardMaterial({ color: 0x5f5e48, roughness: 1 }), 0, 0, 0, pile);
  group.userData.pile = pile;
  return group;
}
addNode("stockpile-01", "Склад руды", buildStockpileMesh(), 10.5);
{
  const [x, , z] = NODE_POSITIONS["stockpile-01"];
  const stackerFrame = stateMat(0xe0a32a, { clearcoat: 0.3 });
  const stacker = new THREE.Group();
  scene.add(stacker);
  const tex = buildConveyorSpan(new THREE.Vector3(4.6, 6.5, 37), new THREE.Vector3(x - 1, 9, z - 0.5), stackerFrame, stacker, 10, 1.3);
  belts.push({ tex, speed: 0.8, isRunning: () => fval("crusher-01", "state") === "crushing" });
}

function buildDumpMesh() {
  const group = new THREE.Group();
  const mound = new THREE.Group();
  group.add(mound);
  let y = 0;
  for (const [rb, rt, h] of [[15, 12, 3.4], [11, 8, 3.4], [7, 4.5, 3]]) {
    const geo = roughen(new THREE.CylinderGeometry(rt, rb, h, 16, 2), 0.07, { keepBelowY: -h / 2 + 0.01 });
    part(geo, MAT.waste, 0, y + h / 2, 0, mound);
    y += h;
  }
  group.userData.mound = mound;
  return group;
}
addNode("dump-01", "Отвал вскрыши", buildDumpMesh(), 14);

// ---------------------------------------------------------------------------
// Fuel station: canopy with state-colored fascia, pump island, tank farm.
// ---------------------------------------------------------------------------

function buildFuelMesh() {
  const group = new THREE.Group();
  const fascia = stateMat(0xa371f7, { clearcoat: 0.2 });
  part(boxG(12, 0.15, 9), MAT.concrete, 0, 0.075, 0, group);
  for (const [x, z] of [[-4.6, -2.6], [4.6, -2.6], [-4.6, 2.6], [4.6, 2.6]]) part(cylG(0.18, 0.18, 4.4, 10), MAT.white, x, 2.3, z, group);
  part(boxG(10.4, 0.3, 6.6), MAT.white, 0, 4.5, 0, group);
  part(boxG(10.8, 0.6, 7.0), fascia, 0, 4.95, 0, group);
  part(boxG(1.2, 0.3, 4.4), MAT.concrete, 0, 0.3, 0, group);
  for (const z of [-1.2, 1.2]) {
    part(boxG(0.7, 1.6, 0.6), MAT.white, 0, 1.25, z, group);
    part(boxG(0.72, 0.4, 0.3), MAT.glass, 0, 1.6, z, group, false);
  }
  for (const z of [-1.4, 1.4]) {
    part(cylG(1.1, 1.1, 6, 20), MAT.tank, 9.2, 1.6, z, group).rotation.z = Math.PI / 2;
    for (const x of [7.2, 11.2]) part(boxG(0.4, 0.6, 1.4), MAT.concrete, x, 0.3, z, group);
  }
  group.userData.colorMats = [fascia];
  return group;
}
addNode("fuel-01", "Заправка", buildFuelMesh(), 8);

// ---------------------------------------------------------------------------
// Repair zone: arched maintenance hangar (door frame follows state) + office.
// Door faces -X, toward the haul roads.
// ---------------------------------------------------------------------------

function buildRepairMesh() {
  const group = new THREE.Group();
  const accent = stateMat(0x8b96a3, { clearcoat: 0.2 });
  part(boxG(26, 0.15, 22), MAT.concrete, -2, 0.075, 0, group);
  const arch = part(new THREE.CylinderGeometry(6.5, 6.5, 14, 28, 1, true, 0, Math.PI), MAT.claddingDouble, 0, 0, 0, group);
  arch.rotation.z = Math.PI / 2;
  const back = part(new THREE.CircleGeometry(6.5, 28, 0, Math.PI), MAT.claddingDouble, 7, 0, 0, group);
  back.rotation.y = Math.PI / 2;
  const frame = part(new THREE.TorusGeometry(6.5, 0.28, 8, 28, Math.PI), accent, -7, 0, 0, group);
  frame.rotation.y = Math.PI / 2;
  part(boxG(6, 3.4, 5), MAT.white, 2, 1.7, 9.5, group);
  part(boxG(6.05, 0.8, 3.6), MAT.glass, 2, 2.2, 9.5, group, false);
  part(boxG(6.2, 0.3, 5.2), accent, 2, 3.55, 9.5, group, false);
  group.userData.colorMats = [accent];
  return group;
}
addNode("repair-01", "Ремзона", buildRepairMesh(), 10.5);

// ---------------------------------------------------------------------------
// Junction: roundabout pad, central island with a traffic signal, dispatch
// booth on stilts.
// ---------------------------------------------------------------------------

function buildJunctionMesh() {
  const group = new THREE.Group();
  const accent = stateMat(0x58a6ff, { clearcoat: 0.2 });
  part(cylG(7.5, 7.5, 0.46, 40), MAT.gravel, 0, 0.23, 0, group); // top 0.46: above all road stripes
  part(cylG(2.2, 2.4, 0.5, 28), MAT.concrete, 0, 0.5, 0, group);
  part(cylG(0.12, 0.12, 6, 8), MAT.steelDark, 0, 3.5, 0, group);
  part(boxG(0.55, 1.5, 0.55), MAT.steelDark, 0, 6.6, 0, group);
  [MAT.lampRed, MAT.lampAmber, MAT.lampGreen].forEach((mat, i) => {
    for (const sz of [-1, 1]) part(new THREE.SphereGeometry(0.16, 10, 8), mat, 0, 7.05 - i * 0.45, sz * 0.29, group, false);
  });
  const bx = 0, bz = -11.5; // in the free sector between the two face roads
  for (const [x, z] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]]) part(cylG(0.1, 0.1, 3, 6), MAT.steel, bx + x, 1.5, bz + z, group);
  part(boxG(3, 2.2, 3), MAT.white, bx, 4.1, bz, group);
  part(boxG(3.05, 0.9, 2.4), MAT.glass, bx, 4.4, bz, group, false);
  part(boxG(3.4, 0.25, 3.4), accent, bx, 5.3, bz, group);
  group.userData.colorMats = [accent];
  return group;
}
addNode("junction-01", "Развязка", buildJunctionMesh(), 10);

// ---------------------------------------------------------------------------
// Haul roads: two-lane gravel surface + safety berms + a glowing
// state-colored center stripe (green open / red closed) that doubles as the
// lane divider. Trucks drive on the right (see LANE_OFFSET / updateTrucks).
// ---------------------------------------------------------------------------

const ROAD_Y = 0.3, ROAD_W = 8.5, LANE_OFFSET = 2.3;
// Where roads actually stop: in front of the crusher's tipping pad and at the
// dump's toe, not in the middle of the building/mound.
const ROAD_NODE_OVERRIDE = { "crusher-01": [0, 0, 19], "dump-01": [-79, 0, 45] };
const roadNode = (id) => ROAD_NODE_OVERRIDE[id] || NODE_POSITIONS[id];

function roadWaypoints(id) {
  const from = aval(id, "from"), to = aval(id, "to");
  const a = roadNode(from), b = roadNode(to);
  if (!a || !b) return null;
  const bend = ROAD_BEND[id];
  return bend ? [a, bend, b] : [a, b];
}

const bermShape = new THREE.Shape();
bermShape.moveTo(-0.9, 0); bermShape.lineTo(0.9, 0); bermShape.lineTo(0.15, 0.85); bermShape.lineTo(-0.15, 0.85); bermShape.closePath();

// Road length in scene units (not km) -- used to keep a minimum gap between
// trucks following each other on the same road.
const roadLengthCache = {};
function roadLengthUnits(id) {
  if (roadLengthCache[id] === undefined) {
    const wp = roadWaypoints(id);
    let len = 0;
    if (wp) for (let i = 0; i < wp.length - 1; i++) len += Math.hypot(wp[i + 1][0] - wp[i][0], wp[i + 1][2] - wp[i][2]);
    roadLengthCache[id] = len || 1;
  }
  return roadLengthCache[id];
}

const roadMeshes = {};
function buildRoads() {
  ROAD_IDS.forEach((id, roadIndex) => {
    const wp = roadWaypoints(id);
    if (!wp) return;
    const group = new THREE.Group();
    const stripeMat = glowMat(0x3fb950, 0.45);
    for (let i = 0; i < wp.length - 1; i++) {
      const a = new THREE.Vector3(...wp[i]), b = new THREE.Vector3(...wp[i + 1]);
      const len = a.distanceTo(b);
      const seg = new THREE.Group();
      seg.position.copy(a).add(b).multiplyScalar(0.5);
      seg.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
      group.add(seg);
      part(boxG(len + ROAD_W * 0.5, 0.3, ROAD_W), MAT.gravel, 0, 0.15, 0, seg, false);
      // Each road's stripe at its own height: where two roads overlap (junction,
      // crusher end) their stripes would otherwise share a plane and z-fight.
      part(boxG(len, 0.04, 1.4), stripeMat, 0, 0.33 + roadIndex * 0.015, 0, seg, false);
      // berms stop short of the ends, leaving room at junctions/loading spots
      const bermLen = len - 16;
      if (bermLen > 2) {
        const geo = new THREE.ExtrudeGeometry(bermShape, { depth: bermLen, bevelEnabled: false });
        for (const side of [-1, 1]) {
          const berm = part(geo, MAT.berm, -bermLen / 2, 0, side * (ROAD_W / 2 + 0.8), seg);
          berm.rotation.y = Math.PI / 2;
        }
      }
    }
    group.userData.colorMats = [stripeMat];
    scene.add(group);
    roadMeshes[id] = group;
    const first = wp[0], last = wp[wp.length - 1];
    beacons[id] = createBeacon([(first[0] + last[0]) / 2, 2.2, (first[2] + last[2]) / 2], 0xff8a3d);
  });
}
// Called from bootstrap().then(), not here: roadWaypoints() reads
// attributes.from/to out of `world`, which is still empty at module-load
// time -- building here silently produced zero road meshes (every road's
// waypoints came back null, since nothing had attributes yet).

// Position AND heading (radians, Y-axis) along a road at fraction
// fracAlongFromTo of its `from`->`to` direction. Heading assumes the moving
// object's local forward is +Z (true for buildTruckMesh below); flip by Math.PI
// for an object actually travelling the reverse (`to`->`from`) direction.
function roadPose(roadId, fracAlongFromTo) {
  const wp = roadWaypoints(roadId);
  if (!wp) return { pos: NODE_POSITIONS["junction-01"], heading: 0 };
  const segPose = (p0, p1, local) => ({
    pos: [p0[0] + (p1[0] - p0[0]) * local, ROAD_Y, p0[2] + (p1[2] - p0[2]) * local],
    heading: Math.atan2(p1[0] - p0[0], p1[2] - p0[2]),
  });
  if (wp.length === 2) return segPose(wp[0], wp[1], fracAlongFromTo);
  // bent road: split the fraction across the two segments by their share of total length
  const segA = new THREE.Vector3(...wp[0]).distanceTo(new THREE.Vector3(...wp[1]));
  const segB = new THREE.Vector3(...wp[1]).distanceTo(new THREE.Vector3(...wp[2]));
  const total = segA + segB;
  const d = fracAlongFromTo * total;
  return d <= segA ? segPose(wp[0], wp[1], d / segA) : segPose(wp[1], wp[2], (d - segA) / segB);
}

// ---------------------------------------------------------------------------
// Where a parked (not hauling/returning) truck stands and which way it faces.
// Trucks sharing a spot get consecutive slots, so a queue reads as a queue
// instead of several trucks stacked inside each other.
// ---------------------------------------------------------------------------

function parkSpotKey(state, exc) {
  if (state === "refueling") return "fuel";
  if (state === "down") return "repair";
  if (state === "blocked_at_junction" || state === "blocked_road" || state === "blocked") return "junction";
  const toDump = exc === "excavator-03";
  if (state === "dumping") return toDump ? "dump" : "crusher";
  if (state === "queued_at_crusher" || state === "queued_stockpile_full") return toDump ? "dump-q" : "crusher-q";
  const e = EXC_LAYOUT[exc] ? exc : "excavator-01";
  return state === "loading" ? `load:${e}` : `q:${e}`;
}

const WASTE_DIR = dirXZ(NODE_POSITIONS["face-waste-01"], NODE_POSITIONS["dump-01"]);
// Off-road distance for waiting trucks: half the road + half a truck + margin.
const BAY_OFFSET = ROAD_W / 2 + 2.6;
const CRUSHER_BAY_X = -BAY_OFFSET - 1;
function parkedPose(key, slot) {
  const at = (x, z, heading) => ({ pos: [x, 0.05, z], heading });
  if (key === "fuel") {
    const [x, , z] = NODE_POSITIONS["fuel-01"];
    return slot < 2 ? at(x + (slot ? 2.5 : -2.5), z, 0) : at(x - 2.5 + 5 * (slot % 2), z - 8 * Math.floor(slot / 2), 0);
  }
  if (key === "repair") {
    const [x, , z] = NODE_POSITIONS["repair-01"];
    return slot < 2 ? at(x - 1, z + (slot ? 3.2 : -3.2), Math.PI / 2) : at(x - 13, z - 3.5 + 7 * (slot % 2), Math.PI / 2);
  }
  if (key === "junction") {
    const [x, , z] = NODE_POSITIONS["junction-01"];
    // angles (in XZ) of the free sectors between the roads leaving the junction
    const JUNCTION_SLOTS = [2.4, 3.0, 2.0, 3.4, 0.1, -0.35];
    const a = JUNCTION_SLOTS[slot % JUNCTION_SLOTS.length];
    const r = 12 + 7 * Math.floor(slot / JUNCTION_SLOTS.length);
    return at(x + Math.cos(a) * r, z + Math.sin(a) * r, -a);
  }
  if (key === "crusher") return at(slot * 4.5, 24.5, Math.PI); // backed up to the hopper
  if (key === "crusher-q") return at(CRUSHER_BAY_X, 17 - 7.5 * slot, 0); // staging bay beside the road
  const D = ROAD_NODE_OVERRIDE["dump-01"];
  if (key === "dump") return at(D[0] - WASTE_DIR[0], D[2] - WASTE_DIR[1], headingOf([-WASTE_DIR[0], -WASTE_DIR[1]]));
  if (key === "dump-q") {
    const back = 7.5 * (slot + 1);
    return at(D[0] - WASTE_DIR[0] * back - WASTE_DIR[1] * BAY_OFFSET, D[2] - WASTE_DIR[1] * back + WASTE_DIR[0] * BAY_OFFSET, headingOf(WASTE_DIR));
  }
  const [kind, exc] = key.split(":");
  const L = EXC_LAYOUT[exc];
  const F = NODE_POSITIONS[L.face];
  if (kind === "load" && slot === 0) return at(F[0], F[2], headingOf(L.u)); // nose toward the exit, bed beside the shovel
  // Waiting trucks stand on the shoulder on the excavator's side, past the
  // excavator, so they never block the lane trucks drive in and out on.
  const along = 14 + 8 * (kind === "load" ? slot - 1 : slot);
  return at(F[0] + L.u[0] * along + L.n[0] * BAY_OFFSET, F[2] + L.u[1] * along + L.n[1] * BAY_OFFSET, headingOf([-L.u[0], -L.u[1]]));
}

// ---------------------------------------------------------------------------
// Haul truck (rigid-frame mining dump truck): frame, dual rear wheels, deck
// with offset cab, engine/grille, tipping body with canopy (state-colored),
// visible ore load. Body tips while dumping; wheels roll with motion.
// Local +Z is forward.
// ---------------------------------------------------------------------------

const WHEEL_RADIUS = 0.95;
const TRUCK_SCALE = 0.8;
function buildWheel(r, w) {
  const pivot = new THREE.Group(); // rotation.x = roll
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 24), [MAT.tire, MAT.tireWall, MAT.tireWall]);
  tire.rotation.z = Math.PI / 2;
  tire.castShadow = true;
  pivot.add(tire);
  part(cylG(r * 0.48, r * 0.48, w + 0.04, 12), MAT.hub, 0, 0, 0, pivot, false).rotation.z = Math.PI / 2;
  return pivot;
}

const sideShape = new THREE.Shape();
sideShape.moveTo(0, 0); sideShape.lineTo(4.6, 0); sideShape.lineTo(4.6, 2.1); sideShape.lineTo(0.35, 1.5); sideShape.lineTo(0, 1.2); sideShape.closePath();
const sideGeo = new THREE.ExtrudeGeometry(sideShape, { depth: 0.16, bevelEnabled: false });

function buildTruckMesh() {
  const group = new THREE.Group();
  const root = new THREE.Group();
  root.scale.setScalar(TRUCK_SCALE);
  group.add(root);
  const bodyMat = stateMat();

  for (const x of [-0.55, 0.55]) part(boxG(0.4, 0.55, 6.0), MAT.steelDark, x, 1.35, 0, root);
  for (const z of [2.1, -1.7]) part(cylG(0.22, 0.22, 3.3, 10), MAT.steelDark, 0, WHEEL_RADIUS, z, root).rotation.z = Math.PI / 2;
  const wheels = [];
  for (const [x, z, w] of [[-1.5, 2.1, 0.65], [1.5, 2.1, 0.65], [-1.15, -1.7, 0.6], [-1.8, -1.7, 0.6], [1.15, -1.7, 0.6], [1.8, -1.7, 0.6]]) {
    const wheel = buildWheel(WHEEL_RADIUS, w);
    wheel.position.set(x, WHEEL_RADIUS, z);
    root.add(wheel);
    wheels.push(wheel);
  }

  part(boxG(3.9, 0.14, 1.7), MAT.paint, 0, 2.25, 2.55, root); // upper deck
  part(boxG(1.9, 1.15, 1.5), MAT.paint, 0, 1.65, 2.6, root); // engine hood
  part(boxG(1.7, 0.9, 0.06), MAT.grille, 0, 1.7, 3.37, root);
  part(boxG(3.9, 0.3, 0.3), MAT.steelDark, 0, 1.0, 3.4, root); // bumper
  for (const x of [-1.3, 1.3]) part(boxG(0.5, 0.22, 0.06), MAT.headlight, x, 2.08, 3.41, root, false);
  part(boxG(1.45, 1.3, 1.4), MAT.paint, -1.1, 2.97, 2.5, root); // cab
  part(boxG(1.35, 0.6, 0.04), MAT.glass, -1.1, 3.2, 3.21, root, false);
  part(boxG(0.04, 0.6, 1.1), MAT.glass, -1.84, 3.2, 2.5, root, false);
  part(cylG(0.4, 0.4, 1.3, 12), MAT.steelDark, 1.25, 1.35, 0.2, root).rotation.x = Math.PI / 2; // fuel tank
  strut(new THREE.Vector3(1.6, 0.6, 3.4), new THREE.Vector3(1.2, 2.25, 2.0), 0.05, MAT.steel, root); // ladder rail

  // Tipping body, hinged at the rear of the frame.
  const bodyPivot = new THREE.Group();
  bodyPivot.position.set(0, 1.95, -3.05);
  root.add(bodyPivot);
  part(boxG(3.4, 0.22, 4.6), bodyMat, 0, 0.1, 2.3, bodyPivot);
  part(sideGeo, bodyMat, -1.7, 0.05, 0, bodyPivot).rotation.y = -Math.PI / 2;
  part(sideGeo, bodyMat, 1.86, 0.05, 0, bodyPivot).rotation.y = -Math.PI / 2;
  part(boxG(3.72, 2.3, 0.18), bodyMat, 0, 1.15, 4.65, bodyPivot);
  part(boxG(3.9, 0.16, 2.6), bodyMat, 0, 2.3, 5.95, bodyPivot); // canopy over the cab
  for (const z of [1.2, 2.4, 3.6]) for (const sx of [-1, 1]) part(boxG(0.1, 1.5, 0.18), bodyMat, sx * 1.9, 0.9, z, bodyPivot, false);
  const load = part(roughen(new THREE.IcosahedronGeometry(1, 1), 0.18), MAT.ore, 0, 1.05, 2.3, bodyPivot);
  load.scale.set(1.5, 0.7, 2.0);
  load.visible = false;

  group.userData.colorMats = [bodyMat];
  group.userData.wheels = wheels;
  group.userData.bodyPivot = bodyPivot;
  group.userData.load = load;
  return group;
}

const truckMeshes = {};
for (const id of TRUCK_IDS) {
  const mesh = buildTruckMesh();
  mesh.userData.id = id;
  scene.add(mesh);
  pickables.push({ mesh, id });
  truckMeshes[id] = mesh;
}

// Per-truck dead-reckoning state: the simulator only pushes a new
// route_position_km roughly once per SIM_INTERVAL (2s default), so drawing
// that raw value directly makes trucks visibly teleport in steps. Instead we
// remember *when* a value last genuinely changed and extrapolate forward
// using speed_kmh + elapsed real time * SPEEDUP every frame, falling back to
// the server value at each correction -- smooth continuous motion that still
// tracks the simulator's actual physics instead of drifting from it.
const truckMotion = {};
function updateTruckMotion(id) {
  const state = fval(id, "state");
  const road = fval(id, "current_road");
  const km = fval(id, "route_position_km") ?? 0;
  const speedKmh = fval(id, "speed_kmh") ?? 0;
  const prev = truckMotion[id];
  if (!prev || prev.state !== state || prev.road !== road || prev.km !== km) {
    truckMotion[id] = { atMs: performance.now(), km, speedKmh, state, road };
  }
  return truckMotion[id];
}

// ---------------------------------------------------------------------------
// Click to inspect
// ---------------------------------------------------------------------------

function findPickableId(object) {
  for (let node = object; node; node = node.parent) {
    if (node.userData?.id) return node.userData.id;
  }
  return null;
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
renderer.domElement.addEventListener("click", (ev) => {
  pointer.x = (ev.clientX / innerWidth) * 2 - 1;
  pointer.y = -(ev.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(pickables.map((p) => p.mesh), true);
  if (!hits.length) return;
  const id = findPickableId(hits[0].object);
  if (id) renderInspect(id);
});

function renderInspect(id) {
  const t = world[id];
  const body = document.getElementById("inspect-body");
  if (!t) { body.textContent = "Нет данных."; return; }
  const rows = [];
  for (const [k, v] of Object.entries(t.attributes || {})) {
    if (k.startsWith("_")) continue;
    rows.push(`<tr><td>${k}</td><td>${v}</td></tr>`);
  }
  for (const [k, f] of Object.entries(t.features || {})) {
    const p = f.properties || {};
    rows.push(`<tr><td>${k}</td><td>${p.value}${p.unit ? " " + p.unit : ""}</td></tr>`);
  }
  body.innerHTML = `<b>${NS}:${id}</b><table>${rows.join("")}</table>`;
}

// ---------------------------------------------------------------------------
// Scenario panel ("what-if")
// ---------------------------------------------------------------------------

const SCENARIOS = [
  { key: "exc1", label: "Отказ экскаватора-01", undo: "Восстановить экскаватор-01", things: ["excavator-01"], feature: "forced_down", on: true, off: false },
  { key: "exc2", label: "Отказ экскаватора-02", undo: "Восстановить экскаватор-02", things: ["excavator-02"], feature: "forced_down", on: true, off: false },
  { key: "roadA", label: "Закрыть основную дорогу (road-main-a)", undo: "Открыть road-main-a", things: ["road-main-a"], feature: "state", on: "closed", off: "open" },
  { key: "roadB", label: "Закрыть резервную дорогу (road-main-b)", undo: "Открыть road-main-b", things: ["road-main-b"], feature: "state", on: "closed", off: "open" },
  { key: "crusher", label: "Остановить дробилку", undo: "Запустить дробилку", things: ["crusher-01"], feature: "forced_down", on: true, off: false },
  { key: "shortage", label: "Вывести truck-05 и truck-06", undo: "Вернуть truck-05 и truck-06", things: ["truck-05", "truck-06"], feature: "forced_down", on: true, off: false },
];
const activeSince = {}; // key -> snapshot taken when turned on

function kpiSnapshot() {
  return {
    throughput: fval("crusher-01", "throughput_tph") ?? 0,
    plan: fval("shift-01", "plan_completion_pct") ?? 0,
    grade: fval("shift-01", "grade_actual") ?? 0,
  };
}

async function applyScenario(scn, on) {
  if (on) activeSince[scn.key] = kpiSnapshot();
  else delete activeSince[scn.key];
  const value = on ? scn.on : scn.off;
  await Promise.all(scn.things.map((id) => writeFeature(id, scn.feature, value)));
}

// Built ONCE: the buttons themselves never get destroyed/recreated again.
// (They used to be rebuilt from scratch every render-loop tick -- ~60x/sec --
// which meant the DOM node under the user's cursor at mousedown was gone,
// replaced by a lookalike, before mouseup; browsers only fire `click` when
// both land on the *same* node, so the buttons visually existed but almost
// never actually registered a click. See team/docs/design-twins.md section 7.)
function initScenarios() {
  const body = document.getElementById("scenarios-body");
  for (const scn of SCENARIOS) {
    const row = document.createElement("div");
    row.className = "row";
    const onBtn = document.createElement("button");
    onBtn.textContent = scn.label;
    onBtn.onclick = () => applyScenario(scn, true);
    const offBtn = document.createElement("button");
    offBtn.textContent = scn.undo;
    offBtn.className = "undo";
    offBtn.onclick = () => applyScenario(scn, false);
    row.append(onBtn, offBtn);
    body.appendChild(row);

    const delta = document.createElement("div");
    delta.className = "scenario-delta";
    delta.id = `delta-${scn.key}`;
    delta.style.cssText = "color:var(--dim);font-size:11px;margin:0 0 4px 2px;min-height:14px;";
    body.appendChild(delta);
  }
}
initScenarios(); // static DOM, doesn't need twin data -- clickable immediately on load

function renderScenarios() {
  for (const scn of SCENARIOS) {
    const delta = document.getElementById(`delta-${scn.key}`);
    if (!delta) continue;
    if (activeSince[scn.key]) {
      const now = kpiSnapshot(), before = activeSince[scn.key];
      delta.textContent = `было ${before.throughput.toFixed(0)} т/ч, план ${before.plan.toFixed(0)}% → сейчас ${now.throughput.toFixed(0)} т/ч, план ${now.plan.toFixed(0)}%`;
    } else {
      delta.textContent = "";
    }
  }
}

// ---------------------------------------------------------------------------
// Dispatch module: reassign a truck to a different excavator
// ---------------------------------------------------------------------------

function renderDispatch() {
  const body = document.getElementById("dispatch-body");
  for (const id of TRUCK_IDS) {
    let row = document.getElementById(`dispatch-${id}`);
    if (!row) {
      row = document.createElement("div");
      row.className = "truck-row";
      row.id = `dispatch-${id}`;
      const label = document.createElement("span");
      label.textContent = id;
      const select = document.createElement("select");
      for (const exc of EXCAVATOR_IDS) {
        const opt = document.createElement("option");
        opt.value = exc; opt.textContent = exc.replace("excavator-", "Э-");
        select.appendChild(opt);
      }
      select.onchange = () => writeFeature(id, "assigned_excavator", select.value);
      row.append(label, select);
      body.appendChild(row);
    }
    const select = row.querySelector("select");
    const current = fval(id, "assigned_excavator");
    if (document.activeElement !== select && current && select.value !== current) select.value = current;
  }
}

// ---------------------------------------------------------------------------
// Ore-quality recommendation module
// ---------------------------------------------------------------------------

function renderRecommendation() {
  const gradeActual = fval("shift-01", "grade_actual") ?? 0;
  const planMin = fval("shift-01", "plan_grade_min") ?? 0;
  const g1 = fval("face-ore-01", "grade") ?? 0;
  const g2 = fval("face-ore-02", "grade") ?? 0;
  let level = "ok", text;
  if (gradeActual <= 0) {
    text = "Накопление данных смены ещё не началось.";
  } else {
    const deficit = planMin - gradeActual;
    const richer = g1 >= g2 ? "Забой-1" : "Забой-2";
    const leaner = g1 >= g2 ? "Забой-2" : "Забой-1";
    if (deficit > 0.02) {
      level = "bad";
      text = `Содержание в подаче ${gradeActual.toFixed(3)}% Cu ниже плана ${planMin.toFixed(2)}%. Сместите самосвалы на ${richer} (сейчас богаче).`;
    } else if (deficit > 0) {
      level = "warn";
      text = `Содержание ${gradeActual.toFixed(3)}% Cu у нижней границы плана (${planMin.toFixed(2)}%) — следите за балансом.`;
    } else {
      level = "ok";
      text = `Содержание ${gradeActual.toFixed(3)}% Cu выше плана ${planMin.toFixed(2)}% — можно сместить часть самосвалов на ${leaner}, не теряя план по качеству.`;
    }
  }
  document.getElementById("recommend-body").innerHTML = `<div class="msg"><span class="dot ${level}"></span>${text}</div>`;
}

// ---------------------------------------------------------------------------
// KPI bar
// ---------------------------------------------------------------------------

function renderKPI() {
  const shift = (id, unit = "") => {
    const v = fval("shift-01", id);
    return v === undefined ? "—" : `${v}${unit}`;
  };
  document.getElementById("kpi").innerHTML = `
    <div class="stat"><span class="v">${shift("plan_completion_pct", "%")}</span><span class="l">план смены</span></div>
    <div class="stat"><span class="v">${shift("tonnes_actual")}</span><span class="l">т на дробилку (план ${shift("plan_tonnes")})</span></div>
    <div class="stat"><span class="v">${shift("grade_actual", "% Cu")}</span><span class="l">содержание (мин. план ${fval("shift-01", "plan_grade_min") ?? "—"}%)</span></div>
    <div class="stat"><span class="v">${fval("crusher-01", "throughput_tph") ?? "—"} т/ч</span><span class="l">дробилка сейчас</span></div>
    <div class="stat"><span class="v">${fval("section-01", "trucks_active") ?? "—"}</span><span class="l">самосвалов активно</span></div>
    <div class="stat"><span class="v">${shift("time_remaining_min")}</span><span class="l">минут до конца смены</span></div>
  `;
}

document.getElementById("legend").innerHTML = `
  <h2>Состояния</h2>
  <div><span class="dot ok"></span>в работе / открыто</div>
  <div><span class="dot warn"></span>погрузка / разгрузка</div>
  <div><span class="dot bad"></span>отказ / закрыто / блок</div>
`;

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function setGroupColor(group, hex) {
  for (const mat of group?.userData.colorMats || []) {
    mat.color.setHex(hex);
    if (mat.userData.glow) mat.emissive.setHex(hex);
  }
}

let lastUIUpdateMs = -Infinity;
let lastFrameMs = performance.now();
const UI_UPDATE_MS = 250; // text panels refresh ~4x/s; 3D motion still runs at full frame rate below
const WHEEL_ROLL_SCALE = 2; // visual-feel multiplier, not a physical gear ratio -- the scene's scale is schematic (see NODE_POSITIONS), not 1 unit = 1 meter
const BODY_TIP_RAD = -0.85;

const _target = new THREE.Vector3();
const _delta = new THREE.Vector3();

const MIN_GAP_UNITS = 9; // bumper-to-bumper spacing for trucks following each other (truck is ~5.8 long)

// Pass 1: where each truck *wants* to be along its road (dead reckoning from
// the simulator's route_position_km). s = fraction of the road already
// driven in the truck's own travel direction (0 = just left, 1 = arrived).
function plannedTruckStates(now) {
  const plans = [];
  for (const id of TRUCK_IDS) {
    const m = updateTruckMotion(id);
    const plan = { id, m, moving: false };
    if (m.road && (m.state === "hauling" || m.state === "returning")) {
      const lengthKm = aval(m.road, "length_km") || 1;
      const elapsedSimH = ((now - m.atMs) / 1000) * SPEEDUP / 3600;
      const km = Math.min(lengthKm, Math.max(0, m.km + m.speedKmh * elapsedSimH));
      plan.moving = true;
      plan.s = km / lengthKm;
    } else {
      plan.key = parkSpotKey(m.state, fval(id, "assigned_excavator"));
    }
    plans.push(plan);
  }
  // Pass 2: the simulator models each road as a queue-free pipe, so two
  // trucks can share a position. Visually, a follower never closes in on the
  // truck ahead of it in the same lane (same road + same direction).
  // A truck parked at the end of a lane (loading at the face, tipping at the
  // crusher/dump) counts as the truck ahead: arriving trucks stop short of it.
  const occupied = new Set(plans.filter((p) => !p.moving).map((p) => p.key));
  const FACE_EXCAVATOR = Object.fromEntries(Object.entries(EXCAVATOR_FACE).map(([e, f]) => [f, e]));
  const laneEndKey = (road, state) => {
    const end = state === "returning" ? aval(road, "from") : aval(road, "to");
    if (FACE_EXCAVATOR[end]) return `load:${FACE_EXCAVATOR[end]}`;
    if (end === "crusher-01") return "crusher";
    if (end === "dump-01") return "dump";
    return null;
  };
  const lanes = {};
  for (const p of plans) if (p.moving) (lanes[`${p.m.road}|${p.m.state}`] ||= []).push(p);
  for (const group of Object.values(lanes)) {
    group.sort((x, y) => y.s - x.s); // leader first
    const gap = MIN_GAP_UNITS / roadLengthUnits(group[0].m.road);
    if (occupied.has(laneEndKey(group[0].m.road, group[0].m.state))) group[0].s = Math.min(group[0].s, 1 - gap);
    for (let i = 1; i < group.length; i++) group[i].s = Math.max(0, Math.min(group[i].s, group[i - 1].s - gap));
  }
  return plans;
}

function updateTrucks(now, dtS) {
  const posAlpha = 1 - Math.exp(-dtS * 14);
  const turnAlpha = 1 - Math.exp(-dtS * 7);
  const slotsTaken = {};
  for (const { id, m, moving, s, key } of plannedTruckStates(now)) {
    const mesh = truckMeshes[id];
    setGroupColor(mesh, colorFor(m.state));
    let pose;
    if (moving) {
      const returning = m.state === "returning";
      const road = roadPose(m.road, returning ? 1 - s : s);
      const heading = returning ? road.heading + Math.PI : road.heading;
      // Keep right: shift into this direction's lane, so oncoming trucks pass
      // each other instead of driving through one another.
      const rx = -Math.cos(heading), rz = Math.sin(heading); // right of travel
      pose = { pos: [road.pos[0] + rx * LANE_OFFSET, road.pos[1], road.pos[2] + rz * LANE_OFFSET], heading };
    } else {
      const slot = slotsTaken[key] = (slotsTaken[key] ?? -1) + 1;
      pose = parkedPose(key, slot);
    }

    _delta.copy(mesh.position);
    mesh.position.lerp(_target.set(pose.pos[0], pose.pos[1], pose.pos[2]), posAlpha);
    _delta.subVectors(mesh.position, _delta);
    mesh.rotation.y += wrapAngle(pose.heading - mesh.rotation.y) * turnAlpha;

    // Roll wheels by distance travelled along the truck's own forward axis.
    const fwd = _delta.x * Math.sin(mesh.rotation.y) + _delta.z * Math.cos(mesh.rotation.y);
    if (Math.abs(fwd) > 0.0005) {
      const roll = (fwd / (WHEEL_RADIUS * TRUCK_SCALE)) * WHEEL_ROLL_SCALE;
      for (const wheel of mesh.userData.wheels) wheel.rotation.x += roll;
    }

    // Body tips up while dumping; load shows whenever there's payload.
    const body = mesh.userData.bodyPivot;
    const tipTarget = m.state === "dumping" ? BODY_TIP_RAD : 0;
    body.rotation.x += (tipTarget - body.rotation.x) * (1 - Math.exp(-dtS * 2.5));
    const payload = fval(id, "payload_t");
    const capacity = aval(id, "capacity_t") || 1;
    const full = payload === undefined ? (m.state === "hauling" ? 1 : 0) : Math.min(1, payload / capacity);
    const load = mesh.userData.load;
    load.visible = full > 0.02 && m.state !== "dumping";
    load.scale.y = 0.25 + 0.55 * full;
  }
}

function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const dtS = Math.min(0.1, (now - lastFrameMs) / 1000);
  lastFrameMs = now;

  updateTrucks(now, dtS);

  for (const id of EXCAVATOR_IDS) {
    const state = fval(id, "state");
    setGroupColor(nodeMeshes[id], colorFor(state));
    updateBeacon(id, state === "down", now);
    animateExcavator(nodeMeshes[id], state === "loading", now, dtS);
  }
  {
    const s = fval("crusher-01", "state");
    setGroupColor(nodeMeshes["crusher-01"], colorFor(s));
    updateBeacon("crusher-01", s === "down", now);
  }
  for (const id of ["fuel-01", "repair-01", "conveyor-01", "face-ore-01", "face-ore-02", "face-waste-01"]) {
    const s = fval(id, "state");
    if (s) setGroupColor(nodeMeshes[id], colorFor(s));
  }
  for (const id of ROAD_IDS) {
    const state = fval(id, "state");
    setGroupColor(roadMeshes[id], colorFor(state));
    updateBeacon(id, state === "closed", now);
  }
  for (const belt of belts) if (belt.isRunning()) belt.tex.offset.y -= belt.speed * dtS;

  const stock = fval("stockpile-01", "tonnes_current") ?? 0;
  nodeMeshes["stockpile-01"].userData.pile.scale.setScalar(0.4 + Math.min(1.6, Math.cbrt(stock / 500)));
  const dumpFill = (fval("dump-01", "tonnes_current") ?? 0) / (aval("dump-01", "capacity_t") || 1);
  nodeMeshes["dump-01"].userData.mound.scale.y = 0.55 + 0.9 * Math.min(1, Math.max(0, dumpFill));

  animateDust(dtS);

  if (now - lastUIUpdateMs >= UI_UPDATE_MS) {
    lastUIUpdateMs = now;
    renderKPI();
    renderScenarios();
    renderDispatch();
    renderRecommendation();
  }

  controls.update();
  renderer.render(scene, camera);
}

window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// Optional deep-link camera for demos/screenshots: ?cam=x,y,z,targetX,targetY,targetZ
{
  const cam = new URLSearchParams(location.search).get("cam")?.split(",").map(Number);
  if (cam?.length === 6 && cam.every(Number.isFinite)) {
    camera.position.set(cam[0], cam[1], cam[2]);
    controls.target.set(cam[3], cam[4], cam[5]);
    controls.update();
  }
}

bootstrap()
  .then(() => {
    const speedup = fval("section-01", "sim_speedup");
    if (typeof speedup === "number" && speedup > 0) SPEEDUP = speedup;
    buildRoads();
    connectSSE();
    tick();
  })
  .catch((err) => {
    document.getElementById("inspect-body").textContent = "Не удалось получить данные из Ditto: " + err.message;
    console.error(err);
  });
