import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { Sky } from "./vendor/Sky.js";
import { EffectComposer } from "./vendor/EffectComposer.js";
import { RenderPass } from "./vendor/RenderPass.js";
import { UnrealBloomPass } from "./vendor/UnrealBloomPass.js";
import { OutputPass } from "./vendor/OutputPass.js";
import { mergeGeometries } from "./vendor/BufferGeometryUtils.js";

const NS = "org.openegiz.pit";

// Keep in sync with constants.py / generate_twins.py.
const THING_IDS = [
  "section-01", "shift-01",
  "face-ore-01", "face-ore-02", "face-waste-01",
  "excavator-01", "excavator-02", "excavator-03",
  "truck-01", "truck-02", "truck-03", "truck-04", "truck-05", "truck-06",
  "road-face1", "road-face2", "road-main-a", "road-main-b", "road-waste",
  "junction-01", "stockpile-01", "crusher-01", "conveyor-01", "dump-01", "fuel-01", "repair-01",
  "bench-n45", "bench-n60", "bench-p10",
];
// Each bench twin and the piece of the pit that IS that bench, so clicking the
// rock opens the twin. Mirrors BENCHES in constants.py.
const BENCH_TWINS = {
  "bench-n45": { elevM: -45, label: "Уступ −45" },
  "bench-n60": { elevM: -60, label: "Уступ −60" },
  "bench-p10": { elevM: 10, label: "Уступ +10" },
};
const TRUCK_IDS = THING_IDS.filter((id) => id.startsWith("truck-"));
const EXCAVATOR_IDS = ["excavator-01", "excavator-02", "excavator-03"];
const EXCAVATOR_FACE = { "excavator-01": "face-ore-01", "excavator-02": "face-ore-02", "excavator-03": "face-waste-01" };
const ROAD_IDS = ["road-face1", "road-face2", "road-main-a", "road-main-b", "road-waste"];

// Schematic layout (meters, arbitrary scale) -- geometry is not sourced,
// see SUBMISSION.md -> Concept, so this is deliberately stylized, not a
// claim about Aktogay's real layout.
// Surface nodes carry their elevation; the three in-pit nodes are placed on
// their benches by pitNodePosition() once the pit profile is known, which is
// why this object is filled in rather than written out whole.
const NODE_POSITIONS = {
  "crusher-01": [0, 0, 35], "stockpile-01": [28, 0, 42], "conveyor-01": [0, 0, 60],
  "fuel-01": [34, 0, 6], "repair-01": [66, 0, -4],
  "face-waste-01": [-96, 0, 10], "dump-01": [-104, 0, 62],
};
// road-main-b bows out from a straight line so it reads as a visibly
// different, longer detour, not an overlap of road-main-a.
// The backup main is the long way round. Its bend is pushed well out to the
// east so the two mains do not leave the pit exit as one doubled line: on the
// Stand a dispatcher has to be able to see which road the ore is taking.
const ROAD_BEND = { "road-main-b": [86, 0, -6] };

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

// Operator commands are written to attributes, never to features. The
// simulator republishes every feature of a twin at once, so a command parked
// in a feature could be overwritten by a publish that was already in flight
// -- and then silently lost. Attributes are the one place the simulator never
// writes. See simulator.py's module docstring.
async function writeAttribute(id, attribute, value) {
  const res = await fetch(`/ditto/api/2/things/${NS}:${id}/attributes/${attribute}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!res.ok) console.error("write failed", id, attribute, res.status, await res.text().catch(() => ""));
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
camera.position.set(78, 68, 120);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(-8, 0, -10);
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 30;
controls.maxDistance = 400;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.update();

// ---------------------------------------------------------------------------
// Post-processing. A restrained bloom so the things that are meant to read as
// lights -- status lamps, down/closed beacons, the closure barrier's flashers,
// headlights -- actually glow, while the sunlit ground and machine paint stay
// below the threshold and never smear.
// ---------------------------------------------------------------------------

// Own render target purely for `samples: 4`: EffectComposer's default target
// has no MSAA, so routing through it would quietly throw away the
// `antialias: true` on the renderer above and bring back jagged bench edges.
const composerTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, composerTarget);
composer.setSize(innerWidth, innerHeight);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.45, 0.55, 0.86));
// Tone mapping and the sRGB conversion have to happen here: three.js applies
// neither when it renders into a render target, so without this pass the
// composited image comes out raw linear and washed out.
composer.addPass(new OutputPass());

// ---------------------------------------------------------------------------
// Sky, sun and an image-based environment baked from the sky itself, so
// MeshStandardMaterial/MeshPhysicalMaterial have something real to reflect
// instead of flat ambient. Low golden-hour sun -- long shadows, warm light,
// fits an open-pit-in-the-steppe mood better than a neutral midday sky.
// ---------------------------------------------------------------------------

// 9deg put the sun almost on the horizon: long shadows, but the steppe floor
// came out near-black and the machines lost all surface detail. Raised again
// once the pit became 30 units deep -- below about 18deg the sun never reaches
// past the second bench, and the two lower working faces, which are the whole
// point of the excavation, sit in near-black self-shadow. Above ~22deg the
// warm low-sun mood goes and the steppe flattens out.
const SUN_ELEVATION_DEG = 19;
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
  u.turbidity.value = 5.5;
  u.rayleigh.value = 1.8;
  u.mieCoefficient.value = 0.007;
  u.mieDirectionalG.value = 0.85;
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
// One knob for how hard the baked sky lights everything. At full strength the
// blue dome washes a cold cast over ground, roads and rock -- which is why the
// haul roads came out looking like pale concrete rather than gravel.
scene.environmentIntensity = 0.62;

scene.fog = new THREE.Fog(0xc69c70, 210, 900);

const sun = new THREE.DirectionalLight(0xffd0a0, 2.9);
// Shadow frustum centered on the pit/junction area (where the actual
// content is), not world origin -- target first, light offset from *that*.
sun.target.position.set(0, 0, -20);
sun.position.copy(sunDirection).multiplyScalar(220).add(sun.target.position);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -190;
sun.shadow.camera.right = 190;
sun.shadow.camera.top = 190;
sun.shadow.camera.bottom = -190;
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 420;
sun.shadow.bias = -0.0015;
scene.add(sun);
scene.add(sun.target);

// Sky-tint fill so shadowed faces aren't pure black; the environment map
// above already carries most of the ambient color now, this just softens it.
// Ground term is a warm sand bounce, not near-black, or everything facing
// away from the sun turns into a silhouette.
// A 7.5-unit wall at a 19deg sun throws a 22-unit shadow across a 12-unit
// bench, so every bench below the rim is fully shaded -- which is true of a
// real pit and makes for good photographs, but it buried the haul roads.
// The fill is what lifts shaded rock without flattening the sunlit steppe.
scene.add(new THREE.HemisphereLight(0xa9c4dd, 0x6b5942, 0.78));

// ---------------------------------------------------------------------------
// Terrain: textured steppe floor with a real hole cut where the pit is, a
// terraced pit bowl with a pit lake, and scattered boulders.
// All of it is schematic -- not a claim about Aktogay's real geometry (see
// SUBMISSION.md -> Concept).
// ---------------------------------------------------------------------------

// Deterministic PRNG: procedural rocks/hills look the same on every reload
// (and on the evaluator's machine) instead of reshuffling each time.
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

// Steppe floor. Drawn in three passes at different blob sizes so the tile
// carries both broad patchiness and fine grit; a single pass at one size
// reads as uniform speckle and makes the repeat obvious from the air.
// Everything wraps (blobs crossing an edge are redrawn on the opposite one),
// so there is no seam where tiles meet.
function makeGroundTexture() {
  const size = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#5e5038";
  ctx.fillRect(0, 0, size, size);

  const blob = (x, y, r, fill) => {
    ctx.fillStyle = fill;
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        ctx.beginPath(); ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2); ctx.fill();
      }
    }
  };
  const PASSES = [
    { n: 200, rMin: 70, rMax: 220, a: 0.11 }, // broad patches of lighter/darker ground
    { n: 620, rMin: 16, rMax: 60, a: 0.16 },  // mid-scale scrub and gravel spreads
    { n: 2600, rMin: 2, rMax: 9, a: 0.28 },   // grit
  ];
  for (const { n, rMin, rMax, a } of PASSES) {
    for (let i = 0; i < n; i++) {
      const shade = 0.72 + rand() * 0.62;
      const g = rand() < 0.22 ? 0.9 : 1; // occasional greener patch of steppe grass
      blob(
        rand() * size, rand() * size, rMin + rand() * (rMax - rMin),
        `rgba(${Math.floor(136 * shade)},${Math.floor(116 * shade * g)},${Math.floor(82 * shade * g * 0.95)},${a * (0.5 + rand())})`,
      );
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ---------------------------------------------------------------------------
// The pit's vertical structure. The benches here are not decoration: each one
// is a bench twin, at the elevation that twin reports, and the ore faces work
// from inside the pit at their own levels rather than on a plane beside it.
// Mirrors BENCHES / NODE_ELEVATION_M in constants.py; a mismatch would put a
// shovel through a wall, so the two have to be read together.
// ---------------------------------------------------------------------------
const PIT_CENTER = { x: 0, z: -88 };
const PIT_RIM_R = 78;
const VSCALE = 0.5;              // scene units per metre of elevation
const BENCH_HEIGHT_M = 15;       // = constants.BENCH_HEIGHT_M
const PIT_LEVELS = 4;            // 0 / -15 / -30 / -45 / -60 m
const PIT_DROP = BENCH_HEIGHT_M * VSCALE;
const PIT_WALL_IN = 5;           // how far each wall leans in over one bench
const PIT_BENCH_W = 12;          // width of the flat bench between two walls

// Elevation in metres of every node, mirroring NODE_ELEVATION_M in
// constants.py. The crusher pad is the reference level.
const NODE_ELEV_M = {
  "crusher-01": 0, "stockpile-01": 0, "conveyor-01": 0, "fuel-01": 0, "repair-01": 0,
  "junction-01": -15, "face-ore-01": -45, "face-ore-02": -60,
  "face-waste-01": 10, "dump-01": 20,
};
// The waste dump is not a pad at an elevation -- it IS the elevation: a mound
// built up from grade whose crest is the dump's registered level. So its mesh
// stands on the ground and its own height carries the number, unlike every
// other node, which is placed at its elevation.
const NODE_MESH_AT_GRADE = new Set(["dump-01"]);
const elevY = (id) => (NODE_ELEV_M[id] ?? 0) * VSCALE;

// Radius of the pit wall at a given depth below the rim, following the same
// bench profile buildPit() constructs. Roads and faces use it so they sit on
// the rock instead of hanging in the air beside it.
function pitWallRadiusAt(depth) {
  let rr = PIT_RIM_R, d = 0;
  for (let i = 0; i < PIT_LEVELS; i++) {
    if (depth <= d + PIT_DROP) return rr - PIT_WALL_IN * ((depth - d) / PIT_DROP);
    rr -= PIT_WALL_IN;
    d += PIT_DROP;
    if (i < PIT_LEVELS - 1) rr -= PIT_BENCH_W;
  }
  return rr;
}

// The haul ramp: one spiral from the pit floor up to the junction, hugging
// the wall. Everything that drives out of the pit drives up this.
const JUNCTION_DEPTH = -elevY("junction-01");
const PIT_FLOOR_DEPTH = PIT_LEVELS * PIT_DROP;
const RAMP_A0 = Math.PI / 2;   // the ramp reaches the junction bench facing the plant
const RAMP_TURN = 3.6;         // radians of turn between there and the floor
const RAMP_INSET = 6;          // ramp centreline, in from the wall
const rampAngleAt = (depth) =>
  RAMP_A0 + RAMP_TURN * ((depth - JUNCTION_DEPTH) / (PIT_FLOOR_DEPTH - JUNCTION_DEPTH));
const pitPolar = (angle, radius, y) =>
  [PIT_CENTER.x + Math.cos(angle) * radius, y, PIT_CENTER.z + Math.sin(angle) * radius];
const rampPointAt = (depth) =>
  pitPolar(rampAngleAt(depth), pitWallRadiusAt(depth) - RAMP_INSET, -depth);
// The ramp runs a little above the junction bench as well, so the two mains
// meet it on the flat instead of at a kink on the bench edge.
const RAMP_TOP_DEPTH = JUNCTION_DEPTH - PIT_DROP * 0.9;

// Where each in-pit node stands: which bench, and how far around it from the
// ramp entry. Keeping them polar means a face cannot drift off its bench.
const PIT_NODE_PLACEMENT = {
  "junction-01": { aroundRamp: 0, inset: RAMP_INSET },
  "face-ore-01": { aroundRamp: 1.45, inset: PIT_BENCH_W / 2 },
  "face-ore-02": { aroundRamp: 2.30, inset: PIT_BENCH_W / 2 },
};
function pitNodePosition(id) {
  const place = PIT_NODE_PLACEMENT[id];
  const depth = -elevY(id);
  return pitPolar(rampAngleAt(depth) + place.aroundRamp,
                  pitWallRadiusAt(depth) - place.inset, -depth);
}

// The stripping bench is a built-up pad: its top carries face-waste-01 and
// its flank is the ramp down to grade. Shared with the pad geometry below so
// the road lands on the slope rather than through it.
const WASTE_PAD = { rTop: 30, rBase: 44 };

// Road geometry. Declared up here with the pit constants because the haul
// ramp is built long before the roads are, and the ramp ribbon has to be the
// same running surface the roads are: a step between them is a truck
// dropping through the carriageway at the pit exit.
const ROAD_Y = 0.3, ROAD_W = 8.5, LANE_OFFSET = 2.3;

for (const id of Object.keys(PIT_NODE_PLACEMENT)) NODE_POSITIONS[id] = pitNodePosition(id);
for (const [id, p] of Object.entries(NODE_POSITIONS)) p[1] = p[1] || elevY(id);

// The ground is three pieces that meet at exactly y = 0:
//   1. the graded site -- flat, with the pit cut out of it;
//   2. a displaced ring of rolling steppe around it;
//   3. a far flat plane past the fog, so the horizon has no visible edge.
// The relief stops at the site boundary on purpose. A working bench and its
// haul roads are graded flat in reality -- undulating ground under a loaded
// 290-tonne truck would be less true to the object, not more -- and it also
// means none of the twin-driven placement has to move.
const SITE_HALF = 260;      // half-width of the graded, flat working area
const TERRAIN_HALF = 2400;  // outer edge of the displaced ring
const TERRAIN_SEG = 240;    // 20 m per quad; both boundaries land on grid lines

const groundTexture = (() => {
  const tex = makeGroundTexture();
  // ShapeGeometry UVs are raw coordinates, so this is "one tile per 62 metres".
  // Larger than it needs to be for grain, deliberately: at 34 the tile's broad
  // patches averaged out into flat mush from any distance, and the only thing
  // left to see was the repeat.
  tex.repeat.set(1 / 62, 1 / 62);
  return tex;
})();
// One material for all three pieces, so they are indistinguishable at the seams.
const groundMaterial = new THREE.MeshStandardMaterial({ map: groundTexture, roughness: 1 });

// Height of the steppe at a point. Zero inside the site and zero again at the
// outer edge, so the displaced ring meets both flat neighbours exactly.
function terrainHeight(x, z) {
  const d = Math.max(Math.abs(x), Math.abs(z));
  const fade =
    THREE.MathUtils.smoothstep(d, SITE_HALF, SITE_HALF + 170) *
    (1 - THREE.MathUtils.smoothstep(d, TERRAIN_HALF - 700, TERRAIN_HALF));
  if (fade <= 0) return 0;
  // Wavelengths are chosen against the distance actually on screen: the first
  // attempt used ~3 km features, which inside the visible few hundred metres
  // read as one flat slope and looked like no relief at all.
  return fade * (
    27 * Math.sin(x * 0.0085 + 1.3) * Math.cos(z * 0.0072 - 0.7) +
    11 * Math.sin(x * 0.019 - 2.1) * Math.cos(z * 0.017 + 1.9) +
    4 * Math.sin(x * 0.044 + 0.4) * Math.cos(z * 0.039 - 1.1)
  );
}

function buildSiteGround() {
  const shape = new THREE.Shape();
  shape.moveTo(-SITE_HALF, -SITE_HALF); shape.lineTo(SITE_HALF, -SITE_HALF);
  shape.lineTo(SITE_HALF, SITE_HALF); shape.lineTo(-SITE_HALF, SITE_HALF); shape.closePath();
  const hole = new THREE.Path();
  // Shape Y becomes world -Z after the -90deg X rotation below.
  hole.absarc(PIT_CENTER.x, -PIT_CENTER.z, PIT_RIM_R, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape, 72), groundMaterial);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.05;
  mesh.receiveShadow = true;
  return mesh;
}

function buildTerrainRing() {
  const step = (TERRAIN_HALF * 2) / TERRAIN_SEG;
  const cols = TERRAIN_SEG + 1;
  const position = new Float32Array(cols * cols * 3);
  const uv = new Float32Array(cols * cols * 2);
  for (let j = 0; j < cols; j++) {
    for (let i = 0; i < cols; i++) {
      const x = -TERRAIN_HALF + i * step;
      const z = -TERRAIN_HALF + j * step;
      const k = j * cols + i;
      position[k * 3] = x;
      position[k * 3 + 1] = terrainHeight(x, z);
      position[k * 3 + 2] = z;
      // Same raw-coordinate UVs as the flat pieces, so the texture runs on
      // across the seam instead of restarting.
      uv[k * 2] = x;
      uv[k * 2 + 1] = -z;
    }
  }
  // Both site boundaries fall exactly on grid lines, so the hole left here is
  // precisely the square the flat site mesh fills -- no gap, no overlap.
  const skipFrom = (TERRAIN_HALF - SITE_HALF) / step;
  const skipTo = (TERRAIN_HALF + SITE_HALF) / step;
  const index = [];
  for (let j = 0; j < TERRAIN_SEG; j++) {
    for (let i = 0; i < TERRAIN_SEG; i++) {
      if (i >= skipFrom && i < skipTo && j >= skipFrom && j < skipTo) continue;
      const a = j * cols + i;
      index.push(a, a + cols, a + cols + 1, a, a + cols + 1, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, groundMaterial);
  mesh.position.y = -0.05;
  mesh.receiveShadow = true;
  return mesh;
}

function buildFarGround() {
  const half = 20000;
  const shape = new THREE.Shape();
  shape.moveTo(-half, -half); shape.lineTo(half, -half); shape.lineTo(half, half); shape.lineTo(-half, half); shape.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-TERRAIN_HALF, -TERRAIN_HALF); hole.lineTo(-TERRAIN_HALF, TERRAIN_HALF);
  hole.lineTo(TERRAIN_HALF, TERRAIN_HALF); hole.lineTo(TERRAIN_HALF, -TERRAIN_HALF); hole.closePath();
  shape.holes.push(hole);
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), groundMaterial);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.05;
  return mesh;
}

scene.add(buildSiteGround());
scene.add(buildTerrainRing());
scene.add(buildFarGround());

const benchTwinMeshes = {};
const benchTwinY = (id) => BENCH_TWINS[id].elevM * VSCALE;
const benchTwinAtY = (y) =>
  Object.keys(BENCH_TWINS).find((id) => Math.abs(benchTwinY(id) - y) < 0.01) || null;

function buildPit() {
  const group = new THREE.Group();
  const { x: cx, z: cz } = PIT_CENTER;
  const wallMats = [
    new THREE.MeshStandardMaterial({ color: 0x6f5d47, roughness: 1, flatShading: true, side: THREE.DoubleSide }),
    new THREE.MeshStandardMaterial({ color: 0x5e4f3c, roughness: 1, flatShading: true, side: THREE.DoubleSide }),
  ];
  const benchMat = new THREE.MeshStandardMaterial({ color: 0x6a5c48, roughness: 1, side: THREE.DoubleSide });
  const LEVELS = PIT_LEVELS, DROP = PIT_DROP, WALL_IN = PIT_WALL_IN, BENCH = PIT_BENCH_W;
  let r = PIT_RIM_R, y = 0;
  for (let i = 0; i < LEVELS; i++) {
    const rBottom = r - WALL_IN;
    const geo = new THREE.CylinderGeometry(r, rBottom, DROP, 108, 6, true);
    // Rugged face: only interior rows move, so the top/bottom rings still
    // meet the benches exactly. Angle-based offsets keep the seam closed.
    //
    // The displacement is deliberately noisy in BOTH axes. With a smooth
    // radial-only wobble on a regular grid, flat shading turned every quad
    // into a flat rectangle of its own shade and the wall read as tiling --
    // which got much more obvious once the pit grew to four benches. Pushing
    // the rows up and down as well breaks the quads out of their rows, so
    // the facets look like broken rock instead of masonry.
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k);
      if (Math.abs(Math.abs(v.y) - DROP / 2) < 1e-3) continue;
      const a = Math.atan2(v.z, v.x);
      const n = 1
        + 0.030 * Math.sin(a * 13 + v.y * 1.7 + i)
        + 0.022 * Math.sin(a * 29 - v.y * 2.3 + i * 3)
        + 0.015 * Math.sin(a * 61 + v.y * 5.1 + i * 7)
        + 0.010 * Math.sin(a * 97 - v.y * 9.3);
      const dy = DROP * (0.055 * Math.sin(a * 23 + i * 2) + 0.035 * Math.sin(a * 53 - v.y * 3.7));
      pos.setXYZ(k, v.x * n, v.y + dy, v.z * n);
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
      // A bench that a bench twin stands for is not merged into the pit: it
      // becomes its own object so clicking the rock opens that twin.
      const twinId = benchTwinAtY(y);
      if (twinId) benchTwinMeshes[twinId] = { mesh: bench, y, rMid: r - BENCH / 2 };
      else group.add(bench);
      r -= BENCH;
    }
  }
  const floor = new THREE.Mesh(new THREE.CircleGeometry(r, 72), benchMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, y, cz);
  floor.receiveShadow = true;
  {
    const twinId = benchTwinAtY(y);
    if (twinId) benchTwinMeshes[twinId] = { mesh: floor, y, rMid: r * 0.62 };
    else group.add(floor);
  }

  // Spiral haul ramp from the rim to the floor -- the same centreline the
  // haul roads are routed along (rampPointAt), so the trucks drive on the
  // ramp rather than through the wall beside it. It is extended a little
  // above the junction bench so the surface roads meet it on the flat.
  const rampMat = new THREE.MeshStandardMaterial({ color: 0x7b6e5a, roughness: 1 });
  const rampAt = (t) => {
    const depth = RAMP_TOP_DEPTH + (PIT_FLOOR_DEPTH - RAMP_TOP_DEPTH) * t;
    const p = rampPointAt(depth);
    return new THREE.Vector3(p[0], p[1], p[2]);
  };
  // One continuous ribbon along the ramp centreline, not a row of boxes.
  // The ramp is 9 units wide but each turn step is only about 6 long, so as
  // boxes the slabs were wider than they were long: at every turn their outer
  // corners fanned out past the wall and the ramp read as a staircase of grey
  // plates. A ribbon follows the curve exactly, so it cannot overhang.
  {
    const RAMP_SEGMENTS = 96, HALF_W = 4.5;
    const pos = [], idx = [];
    const p = new THREE.Vector3(), q = new THREE.Vector3(), tangent = new THREE.Vector3();
    for (let i = 0; i <= RAMP_SEGMENTS; i++) {
      p.copy(rampAt(i / RAMP_SEGMENTS));
      q.copy(rampAt(Math.min(1, (i + 0.5) / RAMP_SEGMENTS)));
      if (i === RAMP_SEGMENTS) q.copy(p).sub(rampAt((i - 0.5) / RAMP_SEGMENTS)).add(p);
      tangent.subVectors(q, p).setY(0).normalize();
      // Horizontal normal: rotate the ground track a quarter turn.
      const nx = -tangent.z, nz = tangent.x;
      pos.push(p.x + nx * HALF_W, p.y + ROAD_Y, p.z + nz * HALF_W);
      pos.push(p.x - nx * HALF_W, p.y + ROAD_Y, p.z - nz * HALF_W);
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const ribbon = new THREE.Mesh(geo, rampMat);
    // Deliberately not a shadow caster: its shadow would fall on the pit wall
    // directly beneath it, which at this sun angle is already in shadow.
    ribbon.receiveShadow = true;
    group.add(ribbon);
  }

  // Bench crest berms: a windrow along the open edge of every bench, which is
  // what actually stops a truck driving off a bench in a real pit, and reads
  // at a glance as "this level is worked" rather than "this is a terrace".
  {
    // Its own material rather than MAT.berm: the shared palette is declared
    // below this function and is still in its temporal dead zone here.
    const crestBermMat = new THREE.MeshStandardMaterial({ color: 0x7a6a52, roughness: 1, flatShading: true });
    let rr = PIT_RIM_R, dd = 0;
    for (let i = 0; i < LEVELS - 1; i++) {
      rr -= WALL_IN; dd += DROP; rr -= BENCH;
      const berm = new THREE.Mesh(new THREE.TorusGeometry(rr + 0.9, 0.85, 6, 64), crestBermMat);
      berm.rotation.x = -Math.PI / 2;
      berm.position.set(cx, -dd + 0.4, cz);
      berm.castShadow = berm.receiveShadow = true;
      group.add(berm);
    }
  }

  // Loose rock on the pit floor, so the bottom is not a clean disc.
  const rubble = new THREE.InstancedMesh(
    roughen(new THREE.IcosahedronGeometry(1, 0), 0.24),
    new THREE.MeshStandardMaterial({ color: 0x6a5c4a, roughness: 1, flatShading: true }),
    44,
  );
  {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const p = new THREE.Vector3(), s = new THREE.Vector3();
    for (let i = 0; i < 44; i++) {
      const a = rand() * Math.PI * 2, rr = r * (0.55 + rand() * 0.42);
      const size = 0.5 + Math.pow(rand(), 2) * 2.2;
      p.set(cx + Math.cos(a) * rr, y + size * 0.3, cz + Math.sin(a) * rr);
      q.setFromEuler(e.set(rand() * 3, rand() * 3, rand() * 3));
      rubble.setMatrixAt(i, m.compose(p, q, s.set(size, size * 0.65, size)));
    }
  }
  rubble.castShadow = rubble.receiveShadow = true;
  group.add(rubble);

  // Copper pits collect blue-green water at the bottom.
  const lake = new THREE.Mesh(
    new THREE.CircleGeometry(r * 0.6, 48),
    new THREE.MeshPhysicalMaterial({ color: 0x2f7377, roughness: 0.22, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.3 }),
  );
  lake.rotation.x = -Math.PI / 2;
  lake.position.set(cx + 3, y + 0.06, cz + 2);
  group.add(lake);
  return group;
}
const pitGroup = buildPit();
scene.add(pitGroup);

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
    positions[i * 3 + 1] = Math.pow(Math.random(), 1.8) * 11 + 0.3; // most of it hangs low, the way blown dust does
    positions[i * 3 + 2] = (Math.random() - 0.5) * DUST_BOUNDS * 2 - 20;
    drift[i] = 0.35 + Math.random() * 0.9;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  // Normal blending, not additive: additive specks read as glowing fireflies
  // (and get picked up by the bloom pass), while airborne dust should only
  // ever soften what is behind it.
  const mat = new THREE.PointsMaterial({
    size: 1.5, map: glowTexture, color: 0xcdb99a, transparent: true, opacity: 0.11,
    depthWrite: false, sizeAttenuation: true, blending: THREE.NormalBlending,
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
// Dust plumes: a fixed pool of billboard puffs, recycled oldest-first, drawn
// in one pass. Trucks raise them from their wheels in proportion to how fast
// they are actually moving, tipping and loading raise bigger ones. This is
// what makes a haul cycle read as work rather than as boxes sliding along
// lines -- a stationary truck raises no dust, a loaded one at speed does.
// ---------------------------------------------------------------------------

const PLUME_MAX = 460;
const plumes = (() => {
  const position = new Float32Array(PLUME_MAX * 3);
  const velocity = new Float32Array(PLUME_MAX * 3);
  const size = new Float32Array(PLUME_MAX);
  const alpha = new Float32Array(PLUME_MAX);
  const sizeFrom = new Float32Array(PLUME_MAX);
  const sizeTo = new Float32Array(PLUME_MAX);
  const peak = new Float32Array(PLUME_MAX);
  const life = new Float32Array(PLUME_MAX);
  const lifeMax = new Float32Array(PLUME_MAX);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geo.setAttribute("size", new THREE.BufferAttribute(size, 1));
  geo.setAttribute("alpha", new THREE.BufferAttribute(alpha, 1));

  // Custom shader rather than PointsMaterial: puffs need per-particle size and
  // opacity, and PointsMaterial has only one of each for the whole system.
  // uFog* replicates scene.fog by hand, which built-in materials get for free
  // but a raw ShaderMaterial does not -- without it the dust stays sharp and
  // dark against haze at the far end of a haul road.
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: glowTexture },
      // Lighter than the ground it is kicked off, or the plume disappears into
      // the road it is supposed to be rising from.
      uColor: { value: new THREE.Color(0xdbcdb0).convertSRGBToLinear() },
      uFogColor: { value: scene.fog.color.clone().convertSRGBToLinear() },
      uFogNear: { value: scene.fog.near },
      uFogFar: { value: scene.fog.far },
      uScale: { value: innerHeight * 0.5 * Math.min(devicePixelRatio, 2) },
    },
    vertexShader: `
      attribute float size;
      attribute float alpha;
      uniform float uScale;
      varying float vAlpha;
      varying float vFogDepth;
      void main() {
        vAlpha = alpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vFogDepth = -mv.z;
        gl_PointSize = size * uScale / max(1.0, -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform vec3 uColor;
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      varying float vAlpha;
      varying float vFogDepth;
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
        if (a < 0.01) discard;
        float f = smoothstep(uFogNear, uFogFar, vFogDepth);
        gl_FragColor = vec4(mix(uColor, uFogColor, f), a);
      }
    `,
    transparent: true,
    depthWrite: false,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 5;
  scene.add(points);

  let cursor = 0;
  function spawn(x, y, z, { s0 = 1.2, s1 = 4.5, lifeS = 1.8, a = 0.34, rise = 0.7, drift = 0 } = {}) {
    const i = cursor;
    cursor = (cursor + 1) % PLUME_MAX;
    position[i * 3] = x + (Math.random() - 0.5) * 0.9;
    position[i * 3 + 1] = y;
    position[i * 3 + 2] = z + (Math.random() - 0.5) * 0.9;
    velocity[i * 3] = (Math.random() - 0.5) * 0.7 + drift;
    velocity[i * 3 + 1] = rise * (0.6 + Math.random() * 0.8);
    velocity[i * 3 + 2] = (Math.random() - 0.5) * 0.7;
    sizeFrom[i] = s0;
    sizeTo[i] = s1 * (0.8 + Math.random() * 0.5);
    peak[i] = a;
    lifeMax[i] = life[i] = lifeS * (0.8 + Math.random() * 0.4);
  }

  function update(dtS) {
    for (let i = 0; i < PLUME_MAX; i++) {
      if (life[i] <= 0) { alpha[i] = 0; continue; }
      life[i] -= dtS;
      const t = 1 - Math.max(0, life[i]) / lifeMax[i];
      position[i * 3] += velocity[i * 3] * dtS;
      position[i * 3 + 1] += velocity[i * 3 + 1] * dtS;
      position[i * 3 + 2] += velocity[i * 3 + 2] * dtS;
      velocity[i * 3 + 1] *= 1 - dtS * 0.6; // puffs stop rising as they spread
      size[i] = sizeFrom[i] + (sizeTo[i] - sizeFrom[i]) * t;
      // Quick bloom, slow decay -- a dust cloud appears at once and lingers.
      alpha[i] = peak[i] * Math.min(1, t * 7) * Math.pow(1 - t, 1.6);
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.size.needsUpdate = true;
    geo.attributes.alpha.needsUpdate = true;
  }

  return { spawn, update, uniforms: mat.uniforms };
})();

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
// time -- no glTF files to vendor, works offline with no network at all.
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

// Haul-road surface. On the road slabs below, U runs along the road and V
// across it, so the two wheel tracks are horizontal bands here. Each road
// segment clones this and sets its own repeat, so the grit stays the same
// physical size whatever the segment's length (see buildRoads).
function makeRoadTexture() {
  const W = 256, H = 256;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#6a5e49";
  ctx.fillRect(0, 0, W, H);

  // Dusty, lighter shoulders where nothing drives.
  for (const y0 of [0, H * 0.88]) {
    const y1 = y0 === 0 ? H * 0.12 : H;
    const grad = ctx.createLinearGradient(0, y0, 0, y1);
    grad.addColorStop(y0 === 0 ? 0 : 1, "rgba(131,119,96,0.7)");
    grad.addColorStop(y0 === 0 ? 1 : 0, "rgba(131,119,96,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, y0, W, y1 - y0);
  }
  // Two compacted wheel tracks, darker in the middle and feathered at the
  // edges. Kept shallow on purpose: at full strength the pair reads as the
  // lane markings of a sealed highway rather than worn gravel.
  for (const cy of [H * 0.27, H * 0.73]) {
    const half = H * 0.1;
    const grad = ctx.createLinearGradient(0, cy - half, 0, cy + half);
    grad.addColorStop(0, "rgba(74,65,52,0)");
    grad.addColorStop(0.5, "rgba(74,65,52,0.38)");
    grad.addColorStop(1, "rgba(74,65,52,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, cy - half, W, half * 2);
  }
  // Grit, denser off the tracks (the tracks are swept smooth by the tyres).
  for (let i = 0; i < 2000; i++) {
    const x = rand() * W, y = rand() * H;
    const onTrack = Math.min(Math.abs(y - H * 0.27), Math.abs(y - H * 0.73)) < H * 0.08;
    if (onTrack && rand() < 0.65) continue;
    const shade = 0.6 + rand() * 0.75;
    ctx.fillStyle = `rgba(${Math.floor(102 * shade)},${Math.floor(92 * shade)},${Math.floor(74 * shade)},${0.25 + rand() * 0.45})`;
    ctx.beginPath(); ctx.arc(x, y, 0.6 + rand() * 2.4, 0, Math.PI * 2); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
const roadTexBase = makeRoadTexture();

const MAT = {
  paint: new THREE.MeshPhysicalMaterial({ color: 0xe0a32a, roughness: 0.5, metalness: 0, clearcoat: 0.65, clearcoatRoughness: 0.32 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x8a929b, roughness: 0.45, metalness: 1 }),
  steelDark: new THREE.MeshStandardMaterial({ color: 0x3a4047, roughness: 0.72, metalness: 1 }),
  steelDarkDouble: new THREE.MeshStandardMaterial({ color: 0x3a4047, roughness: 0.72, metalness: 1, side: THREE.DoubleSide }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.15, metalness: 1 }),
  tire: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, map: makeStripeTexture({ base: "#18191c", line: "#0a0a0c", every: 8, width: 4, repeat: [3, 1] }) }),
  tireWall: new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: 0.85 }),
  // Dusty wheel hub, not a mirror: at roughness 0.4 a full metal caught the
  // whole sky and read as a white disc stuck on the tyre.
  hub: new THREE.MeshStandardMaterial({ color: 0x7d838a, roughness: 0.62, metalness: 1 }),
  track: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0, map: makeStripeTexture({ base: "#2a2b2e", line: "#121314", every: 16, width: 6, repeat: [1, 6] }) }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0x1f3242, roughness: 0.05, metalness: 0, clearcoat: 1, envMapIntensity: 2.2 }),
  grille: new THREE.MeshStandardMaterial({ color: 0x1d2024, roughness: 0.65, metalness: 1 }),
  headlight: new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xffe9a8, emissiveIntensity: 1.4, roughness: 0.3 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x968f83, roughness: 0.95 }),
  // Off-white, not white: against a low warm sun with a sky environment map,
  // pure white cladding blows out and the buildings read as blank cut-outs.
  white: new THREE.MeshStandardMaterial({ color: 0xcdc6b7, roughness: 0.62, metalness: 0 }),
  cladding: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0, map: makeStripeTexture({ base: "#aeb1ab", line: "#84877f", every: 16, width: 5, repeat: [6, 1] }) }),
  claddingDouble: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0, side: THREE.DoubleSide, map: makeStripeTexture({ base: "#a3a69f", line: "#7b7e76", every: 16, width: 5, repeat: [12, 3] }) }),
  tank: new THREE.MeshStandardMaterial({ color: 0xd9dcdf, roughness: 0.38, metalness: 1 }),
  ore: new THREE.MeshStandardMaterial({ color: 0x6b5d47, roughness: 1, flatShading: true }),
  // Copper-sulphide ore: greyer/greener than the waste rock, so ore and waste
  // piles are told apart by color alone.
  orePile: new THREE.MeshStandardMaterial({ color: 0x5f5e48, roughness: 1, flatShading: true }),
  waste: new THREE.MeshStandardMaterial({ color: 0x796c59, roughness: 1, flatShading: true }),
  gravel: new THREE.MeshStandardMaterial({ color: 0x75685a, roughness: 1 }),
  berm: new THREE.MeshStandardMaterial({ color: 0x5f5242, roughness: 1, flatShading: true }),
  lampRed: new THREE.MeshStandardMaterial({ color: 0xff4433, emissive: 0xff2a1a, emissiveIntensity: 1.5 }),
  lampAmber: new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0xff9900, emissiveIntensity: 0.4 }),
  lampGreen: new THREE.MeshStandardMaterial({ color: 0x3fdc5a, emissive: 0x22cc44, emissiveIntensity: 1.5 }),
  lampWhite: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2cc, emissiveIntensity: 2 }),
};

// Paint that follows twin state (setGroupColor writes .color).
const stateMat = (hex = 0x8b96a3, opts = {}) =>
  new THREE.MeshPhysicalMaterial({ color: hex, roughness: 0.52, metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.32, ...opts });
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

// Labels carry the twin's name AND its current headline number, so the scene
// answers "how much / how fast / how full" on its own instead of sending the
// viewer to a side panel for every object. Redrawn only when the text
// actually changes (see updateLabels), not per frame.
const LABEL_W = 512, LABEL_H = 176;
const LABEL_FONT = '-apple-system, "Segoe UI", Roboto, sans-serif';

function drawLabel(ctx, title, sub, dot) {
  ctx.clearRect(0, 0, LABEL_W, LABEL_H);
  const pad = 8;
  const h = sub ? LABEL_H - pad * 2 : 98;
  const y0 = sub ? pad : (LABEL_H - h) / 2;
  const titleY = y0 + (sub ? 46 : h / 2);

  ctx.fillStyle = "rgba(11,14,19,0.82)";
  ctx.strokeStyle = "rgba(216,222,230,0.22)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(pad, y0, LABEL_W - pad * 2, h, 22);
  else ctx.rect(pad, y0, LABEL_W - pad * 2, h);
  ctx.fill();
  ctx.stroke();

  let x = pad + 24;
  if (dot != null) {
    ctx.fillStyle = "#" + dot.toString(16).padStart(6, "0");
    ctx.beginPath(); ctx.arc(x + 12, titleY, 13, 0, Math.PI * 2); ctx.fill();
    x += 46;
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const room = LABEL_W - x - pad - 12;
  let fs = 46;
  ctx.font = `bold ${fs}px ${LABEL_FONT}`;
  while (ctx.measureText(title).width > room && fs > 24) {
    fs -= 2;
    ctx.font = `bold ${fs}px ${LABEL_FONT}`;
  }
  ctx.fillStyle = "#eef2f7";
  ctx.fillText(title, x, titleY);
  if (sub) {
    let ss = 34;
    ctx.font = `${ss}px ${LABEL_FONT}`;
    while (ctx.measureText(sub).width > room && ss > 20) {
      ss -= 2;
      ctx.font = `${ss}px ${LABEL_FONT}`;
    }
    ctx.fillStyle = "#9fb0c2";
    ctx.fillText(sub, x, y0 + 114);
  }
}

// The shadow pass costs one draw call per casting mesh, every frame, on top
// of the scene's own. Measured on the live stand it was 418 of 1079 calls --
// 39% of the frame spent re-drawing, among other things, wheel hubs, lamp
// housings, handrails and bucket teeth, none of which a viewer could pick out
// of a shadow. Anything below about half a cubic metre of bounding volume
// stops casting; the masses that actually shape a machine's shadow (body,
// bed, tracks, house, boom) are far above the threshold and keep casting.
const _shadowBox = new THREE.Box3();
const _shadowSize = new THREE.Vector3();
function pruneShadowCasters(root, minVolume = 0.5) {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || !o.castShadow) return;
    _shadowBox.setFromObject(o).getSize(_shadowSize);
    if (_shadowSize.x * _shadowSize.y * _shadowSize.z < minVolume) o.castShadow = false;
  });
}

// ---------------------------------------------------------------------------
// Static-geometry merging. Every building here is assembled from dozens of
// small primitives, and each one is its own draw call, every frame, forever.
// None of them ever move relative to their building, so after the scene is
// built their geometries are baked into the group's own space and merged into
// one mesh per (material, shadow flags). Measured: the plant and roads drop
// from hundreds of calls to a few dozen.
//
// What is deliberately left alone: anything animated (the excavators' rig,
// the trucks, the stockpile cone and dump mound that scale with tonnage),
// instanced meshes, and multi-material meshes. Those are marked `noMerge`.
// ---------------------------------------------------------------------------

const MERGE_ATTRS = ["position", "normal", "uv"];

// Checks obj and every ancestor up to (but not including) root. Root's own
// flag is about its parent's merge pass, not this one -- a rigid sub-body is
// marked noMerge so the hull skips it, and is then merged as its own root.
function hasNoMergeAncestor(obj, root) {
  for (let n = obj; n && n !== root; n = n.parent) if (n.userData?.noMerge) return true;
  return false;
}

function mergeStaticGroup(root) {
  root.updateMatrixWorld(true);
  const toLocal = root.matrixWorld.clone().invert();
  const buckets = new Map();
  const originals = [];

  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || Array.isArray(o.material)) return;
    if (hasNoMergeAncestor(o, root)) return;
    const geo = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone());
    // Inputs must agree on their attribute set, and the merge rejects a mix of
    // indexed and non-indexed geometry -- hence toNonIndexed above and this.
    for (const name of Object.keys(geo.attributes)) {
      if (!MERGE_ATTRS.includes(name)) geo.deleteAttribute(name);
    }
    if (MERGE_ATTRS.some((name) => !geo.attributes[name])) return; // nothing to align it with
    geo.applyMatrix4(toLocal.clone().multiply(o.matrixWorld));

    const key = `${o.material.uuid}|${o.castShadow}|${o.receiveShadow}`;
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = { material: o.material, cast: o.castShadow, receive: o.receiveShadow, geos: [] }));
    bucket.geos.push(geo);
    originals.push(o);
  });

  let merged = 0;
  for (const bucket of buckets.values()) {
    if (bucket.geos.length < 2) continue;
    const geometry = mergeGeometries(bucket.geos, false);
    if (!geometry) continue; // incompatible inputs: leave this bucket as separate meshes
    const mesh = new THREE.Mesh(geometry, bucket.material);
    mesh.castShadow = bucket.cast;
    mesh.receiveShadow = bucket.receive;
    root.add(mesh);
    for (const geo of bucket.geos) geo.dispose();
    merged += bucket.geos.length;
    bucket.done = true;
  }
  for (const o of originals) {
    const key = `${o.material.uuid}|${o.castShadow}|${o.receiveShadow}`;
    if (buckets.get(key)?.done) o.removeFromParent();
  }
  return merged;
}

const labelSprites = {}; // id -> Sprite with userData.set(title, sub, dotHex)

function makeLabel(title, scale = 1) {
  const canvas = document.createElement("canvas");
  canvas.width = LABEL_W; canvas.height = LABEL_H;
  const ctx = canvas.getContext("2d");
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const baseW = 10.5 * scale;
  sprite.userData.baseW = baseW;
  sprite.scale.set(baseW, (baseW * LABEL_H) / LABEL_W, 1);
  sprite.renderOrder = 10;

  sprite.userData.title = title;
  let last = null;
  sprite.userData.set = (t, sub = "", dot = null) => {
    const key = `${t}|${sub}|${dot}`;
    if (key === last) return;
    last = key;
    drawLabel(ctx, t, sub, dot);
    tex.needsUpdate = true;
  };
  sprite.userData.set(title);
  return sprite;
}

const pickables = []; // { mesh, id } -- mesh is a Group; raycast is recursive, see findPickableId
const nodeMeshes = {}; // id -> Group

function addNode(id, label, group, labelY) {
  const [x, ey, z] = NODE_POSITIONS[id];
  const y = NODE_MESH_AT_GRADE.has(id) ? 0 : ey;
  group.position.set(x, y, z);
  group.userData.id = id;
  scene.add(group);
  const sprite = makeLabel(label);
  sprite.position.set(x, y + labelY, z);
  scene.add(sprite);
  labelSprites[id] = sprite;
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
  const pos = [F[0] + n[0] * 8.5, F[1], F[2] + n[1] * 8.5];
  const pile = [pos[0] - u[0] * 8.5, F[1], pos[2] - u[1] * 8.5];
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

// Face labels ride well above the excavator labels below them: both sit over
// the same patch of ground and at a shallow camera angle they overlap.
addNode("face-ore-01", "Забой-1", buildFaceMesh("excavator-01", true), 16.5);
addNode("face-ore-02", "Забой-2", buildFaceMesh("excavator-02", true), 16.5);
addNode("face-waste-01", "Уступ вскрыши", buildFaceMesh("excavator-03", false), 16.5);

// Register the two in-pit benches as objects of their own, plus a graded
// plateau for the stripping bench above the rim. Without this the bench twins
// exist in Ditto but there is nothing on the Stand to click, and a twin you
// cannot see is a twin you cannot verify.
const benchGroups = {};
// Where the highlight ring goes for a bench: concentric with the pit at the
// bench's own radius, because the "object" is an annulus of rock, not a
// compact machine. Without this the generic path rings the group's origin --
// world zero -- at the radius of the whole pit.
const BENCH_RING = {};
function addBenchTwin(id, mesh, labelAngle, labelRadius) {
  BENCH_RING[id] = { x: PIT_CENTER.x, z: PIT_CENTER.z, y: benchTwinY(id), r: labelRadius };
  const group = new THREE.Group();
  group.add(mesh);
  group.userData.id = id;
  scene.add(group);
  benchGroups[id] = group;
  pickables.push({ mesh: group, id });
  nodeMeshes[id] = group;
  const [lx, , lz] = pitPolar(labelAngle, labelRadius, 0);
  const sprite = makeLabel(BENCH_TWINS[id].label, 0.82);
  sprite.position.set(lx, benchTwinY(id) + 7.5, lz);
  scene.add(sprite);
  labelSprites[id] = sprite;
}
for (const id of ["bench-n45", "bench-n60"]) {
  const b = benchTwinMeshes[id];
  if (b) addBenchTwin(id, b.mesh, rampAngleAt(-b.y) - 1.25, b.rMid);
}
{
  // The stripping bench is a graded pad above grade, not a cut into the pit:
  // it is the ground face-waste-01 and excavator-03 actually stand on.
  const W = NODE_POSITIONS["face-waste-01"];
  // A cut-and-fill bench, so its flank is a slope the haul road climbs, not a
  // cliff the road would cut through. WASTE_PAD is shared with roadWaypoints.
  const pad = new THREE.Mesh(
    roughen(new THREE.CylinderGeometry(WASTE_PAD.rTop, WASTE_PAD.rBase, Math.max(0.6, W[1]), 56, 2), 0.04,
            { keepBelowY: -Math.max(0.6, W[1]) / 2 + 0.01 }),
    new THREE.MeshStandardMaterial({ color: 0x6a5c48, roughness: 1, flatShading: true }),
  );
  pad.position.set(W[0], W[1] / 2, W[2]);
  pad.receiveShadow = true;
  const group = new THREE.Group();
  group.add(pad);
  group.userData.id = "bench-p10";
  scene.add(group);
  benchGroups["bench-p10"] = group;
  pickables.push({ mesh: group, id: "bench-p10" });
  nodeMeshes["bench-p10"] = group;
  BENCH_RING["bench-p10"] = { x: W[0], z: W[2], y: W[1], r: 31 };
  const sprite = makeLabel(BENCH_TWINS["bench-p10"].label, 0.82);
  sprite.position.set(W[0] - 22, W[1] + 7.5, W[2] + 16);
  scene.add(sprite);
  labelSprites["bench-p10"] = sprite;
}

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
  turret.userData.noMerge = true; // slews; carries the whole boom rig
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
  boomPivot.userData.noMerge = true; // luffs relative to the turret
  boomPivot.position.set(0.35, 1.5, 1.3);
  turret.add(boomPivot);
  part(boxG(0.75, 0.85, 5.0), MAT.paint, 0, 0, 2.5, boomPivot);
  // boom rams: from the house deck up to the boom's underside
  for (const rx of [-0.5, 0.5]) strut(new THREE.Vector3(rx, -1.2, 0.2), new THREE.Vector3(rx, -0.3, 2.6), 0.13, MAT.chrome, boomPivot);

  const stickPivot = new THREE.Group();
  stickPivot.userData.noMerge = true;
  stickPivot.position.set(0, 0, 4.9);
  boomPivot.add(stickPivot);
  part(boxG(0.55, 0.6, 3.4), MAT.paint, 0, 0, 1.7, stickPivot);
  strut(new THREE.Vector3(0, 0.55, -1.6), new THREE.Vector3(0, 0.45, 0.6), 0.11, MAT.chrome, stickPivot);

  const bucket = new THREE.Group();
  bucket.userData.noMerge = true;
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
  mesh.position.set(L.pos[0], L.pos[1], L.pos[2]);
  mesh.rotation.y = L.facing;
  mesh.userData.id = id;
  mesh.userData.swing = L.swing;
  mesh.userData.phase = i * 0.37;
  scene.add(mesh);
  const label = makeLabel(`Экскаватор-${id.slice(-2)}`);
  label.position.set(L.pos[0], L.pos[1] + 8.6, L.pos[2]);
  scene.add(label);
  labelSprites[id] = label;
  pickables.push({ mesh, id });
  nodeMeshes[id] = mesh;
  beacons[id] = createBeacon([L.pos[0], L.pos[1] + 8.5, L.pos[2]]);
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
  pile.userData.noMerge = true; // scales with tonnes_current every frame
  group.userData.pile = pile;
  return group;
}
addNode("stockpile-01", "Склад руды", buildStockpileMesh(), 10.5);
let stackerGroup = null; // radial stacker feeding the pile; captured so it can be merged
{
  const [x, , z] = NODE_POSITIONS["stockpile-01"];
  const stackerFrame = stateMat(0xe0a32a, { clearcoat: 0.3 });
  const stacker = new THREE.Group();
  stackerGroup = stacker;
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
  mound.userData.noMerge = true; // scales with the dump's fill level
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

const _yAxis = new THREE.Vector3(0, 1, 0), _zAxis = new THREE.Vector3(0, 0, 1);
const _qPitch = new THREE.Quaternion();
// Where roads actually stop: in front of the crusher's tipping pad and at the
// dump's toe, not in the middle of the building/mound.
const ROAD_NODE_OVERRIDE = {
  "crusher-01": [0, 0, 19],
  "dump-01": [-102.3, 3.4, 50.6],  // on the dump's second lift, where trucks tip
};
const roadNode = (id) => ROAD_NODE_OVERRIDE[id] || NODE_POSITIONS[id];

// A road that starts inside the pit cannot run straight to the junction --
// that line goes through rock. It runs along its own bench to the head of
// the haul ramp, then climbs the ramp. This is where the pit's depth turns
// into haul distance and grade, which is the whole reason the benches have
// elevations in the first place.
function pitExitWaypoints(fromId) {
  const depth = -elevY(fromId);
  const place = PIT_NODE_PLACEMENT[fromId];
  const aFace = rampAngleAt(depth) + place.aroundRamp;
  const aRamp = rampAngleAt(depth);
  const pts = [];
  const ARC_STEPS = 14;
  for (let i = 0; i <= ARC_STEPS; i++) {
    const a = aFace + (aRamp - aFace) * (i / ARC_STEPS);
    pts.push(pitPolar(a, pitWallRadiusAt(depth) - place.inset, -depth));
  }
  const UP_STEPS = 12;
  for (let i = 1; i <= UP_STEPS; i++) {
    pts.push(rampPointAt(depth + (JUNCTION_DEPTH - depth) * (i / UP_STEPS)));
  }
  // Both ore roads climb the same ramp, and the ramp is already built as
  // geometry. Paving them again here would stack three surfaces in the same
  // place -- which is what made the ramp read as a pale slab laid over the
  // rim. buildRoads() paves only this index range; trucks still drive the
  // whole polyline, because the ramp is the road.
  pts.pave = [0, ARC_STEPS];
  pts.pitSurface = true;
  return pts;
}

function roadWaypoints(id) {
  const from = aval(id, "from"), to = aval(id, "to");
  const a = roadNode(from), b = roadNode(to);
  if (!a || !b) return null;
  if (PIT_NODE_PLACEMENT[from] && to === "junction-01") return pitExitWaypoints(from);
  if (from === "junction-01") {
    // The junction stands on the -15 bench, the plant stands at grade. A
    // straight line between them runs through the rim, which is exactly what
    // it looked like: the two mains disappeared into the rock. They leave the
    // pit the only way anything leaves it -- up the haul ramp -- and only
    // then run across the surface to the crusher.
    const OUT = 8;
    const pts = [a];
    for (let i = 1; i <= OUT; i++) {
      pts.push(rampPointAt(JUNCTION_DEPTH + (RAMP_TOP_DEPTH - JUNCTION_DEPTH) * (i / OUT)));
    }
    const bend = ROAD_BEND[id];
    if (bend) pts.push([bend[0], 0, bend[2]]);
    pts.push(b);
    // Pave only the surface run; the ramp is already there.
    pts.pave = [OUT, pts.length - 1];
    return pts;
  }
  if (from === "face-waste-01") {
    // Off the top of the stripping bench, down its flank, then across to the
    // dump. Without the two edge points the road spanned the drop in one
    // straight segment and sank into the pad.
    const W = NODE_POSITIONS["face-waste-01"];
    const [ux, uz] = dirXZ(W, b);
    return [
      a,
      [W[0] + ux * WASTE_PAD.rTop, W[1], W[2] + uz * WASTE_PAD.rTop],
      [W[0] + ux * WASTE_PAD.rBase, 0, W[2] + uz * WASTE_PAD.rBase],
      b,
    ];
  }
  const bend = ROAD_BEND[id];
  if (!bend) return [a, b];
  // The bend sits at the height the straight line would have had there, so a
  // detour does not dive through the ground or float over it.
  return [a, [bend[0], (a[1] + b[1]) / 2 + bend[1], bend[2]], b];
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
    if (wp) for (let i = 0; i < wp.length - 1; i++) {
      len += Math.hypot(wp[i + 1][0] - wp[i][0], wp[i + 1][1] - wp[i][1], wp[i + 1][2] - wp[i][2]);
    }
    roadLengthCache[id] = len || 1;
  }
  return roadLengthCache[id];
}

// A closed road used to be signalled only by recolouring its centre stripe and
// a beacon. That reads as "a red line" rather than "you cannot drive here", so
// a closure now also drops a real barrier onto the carriageway: jersey blocks,
// a striped boom, a no-entry plate and two flashing amber lamps.
const roadBarriers = {};
const barrierStripeTex = makeStripeTexture({ base: "#a82114", line: "#e4e0d6", every: 22, width: 11, repeat: [10, 1] });

function buildRoadBarrier(id) {
  const pose = roadPose(id, 0.14);
  const group = new THREE.Group();
  group.position.set(pose.pos[0], pose.pos[1] - ROAD_Y, pose.pos[2]);
  group.rotation.y = pose.heading; // local +Z runs from the road's `from` toward its `to`
  group.visible = false;
  scene.add(group);

  const half = ROAD_W / 2;
  part(boxG(ROAD_W + 1.4, 0.45, 0.3), new THREE.MeshStandardMaterial({ map: barrierStripeTex, roughness: 0.8 }), 0, 1.85, 0, group);
  for (const sx of [-1, 1]) {
    part(cylG(0.13, 0.16, 2.6, 8), MAT.steelDark, sx * (half + 0.7), 1.3, 0, group);
    part(boxG(2.3, 0.95, 0.85), MAT.concrete, sx * 2.9, 0.48, -1.4, group);
  }

  // No-entry plate on its own post, facing the traffic that would arrive here.
  const sign = new THREE.Group();
  sign.position.set(half + 2.4, 0, 0);
  sign.rotation.y = Math.PI;
  group.add(sign);
  part(cylG(0.09, 0.09, 3.2, 8), MAT.steelDark, 0, 1.6, 0, sign);
  part(new THREE.CircleGeometry(0.85, 24), new THREE.MeshStandardMaterial({ color: 0xcc2a1e, roughness: 0.5, side: THREE.DoubleSide }), 0, 3.1, 0.06, sign, false);
  part(boxG(1.15, 0.26, 0.04), MAT.white, 0, 3.1, 0.1, sign, false);

  const lampMats = [];
  for (const sx of [-1, 1]) {
    const mat = glowMat(0xffa21f, 2.2);
    part(new THREE.SphereGeometry(0.24, 12, 10), mat, sx * (half + 0.7), 2.75, 0, group, false);
    lampMats.push(mat);
  }
  roadBarriers[id] = { group, lampMats };
}

function updateBarrier(id, closed, nowMs) {
  const b = roadBarriers[id];
  if (!b) return;
  b.group.visible = closed;
  if (!closed) return;
  // The two lamps alternate, the way a real closure beacon pair does.
  const phase = Math.floor(nowMs / 420) % 2;
  b.lampMats.forEach((mat, i) => { mat.emissiveIntensity = i === phase ? 3.2 : 0.25; });
}

const roadMeshes = {};
function buildRoads() {
  ROAD_IDS.forEach((id, roadIndex) => {
    const wp = roadWaypoints(id);
    if (!wp) return;
    const group = new THREE.Group();
    const stripeMat = glowMat(0x3fb950, 0.3);
    const [paveFrom, paveTo] = wp.pave ?? [0, wp.length - 1];
    for (let i = 0; i < wp.length - 1; i++) {
      if (i < paveFrom || i >= paveTo) continue; // the shared haul ramp carries the rest
      const a = new THREE.Vector3(...wp[i]), b = new THREE.Vector3(...wp[i + 1]);
      const len = a.distanceTo(b);
      const seg = new THREE.Group();
      // No ROAD_Y here: the carriageway box already sits from 0 to ROAD_Y
      // above the waypoint, so its top lands exactly at the height
      // roadPose() puts the trucks at. Adding it again lifted the road by
      // its own thickness and the trucks drove buried in it.
      seg.position.copy(a).add(b).multiplyScalar(0.5);
      // Yaw along the ground track, then tilt about the segment's own Z so
      // the carriageway lies on the slope. A ramp built from flat slabs
      // stair-steps; this is what makes the climb out of the pit read as a
      // climb rather than a stack of terraces.
      const run = Math.hypot(b.x - a.x, b.z - a.z) || 1e-6;
      seg.quaternion.setFromAxisAngle(_yAxis, -Math.atan2(b.z - a.z, b.x - a.x));
      seg.quaternion.multiply(_qPitch.setFromAxisAngle(_zAxis, Math.atan2(b.y - a.y, run)));
      group.add(seg);
      const surfaceTex = roadTexBase.clone();
      surfaceTex.needsUpdate = true;
      surfaceTex.repeat.set((len + ROAD_W * 0.5) / 11, 1);
      const surfaceMat = new THREE.MeshStandardMaterial({
        map: surfaceTex, roughness: 1,
        color: wp.pitSurface ? 0x9f937d : 0xffffff,
      });
      // Straight roads get a little extra length so consecutive boxes close
      // the gap at a corner. On the short, tightly-angled segments of a bench
      // arc that same overhang made each box stand proud of the next, and the
      // road read as a row of plates instead of a road.
      const over = wp.pitSurface ? 0.6 : ROAD_W * 0.5;
      part(boxG(len + over, 0.3, ROAD_W), surfaceMat, 0, 0.15, 0, seg, false);
      // Each road's stripe at its own height: where two roads overlap (junction,
      // crusher end) their stripes would otherwise share a plane and z-fight.
      part(boxG(len, 0.04, 0.95), stripeMat, 0, 0.33 + roadIndex * 0.015, 0, seg, false);
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
    group.userData.id = id;
    scene.add(group);
    roadMeshes[id] = group;
    pickables.push({ mesh: group, id }); // roads are twins too -- clicking one inspects it
    const mid = roadPose(id, wp.pitSurface ? 0.1 : 0.5).pos;
    beacons[id] = createBeacon([mid[0], mid[1] + 2.2, mid[2]], 0xff8a3d);
    const label = makeLabel(id, 0.72);
    label.position.set(mid[0], mid[1] + 4.6, mid[2]);
    scene.add(label);
    labelSprites[id] = label;
    buildRoadBarrier(id);
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
  if (!wp) return { pos: NODE_POSITIONS["junction-01"], heading: 0, pitch: 0 };
  const segPose = (p0, p1, local) => [
    p0[0] + (p1[0] - p0[0]) * local,
    p0[1] + (p1[1] - p0[1]) * local + ROAD_Y,
    p0[2] + (p1[2] - p0[2]) * local,
  ];
  // Walk the polyline by arc length, so a ramp of many short segments is
  // traversed at an even speed instead of racing through the tight turns.
  const seg = [];
  let total = 0;
  for (let i = 0; i < wp.length - 1; i++) {
    const len = new THREE.Vector3(...wp[i]).distanceTo(new THREE.Vector3(...wp[i + 1])) || 1e-6;
    seg.push(len);
    total += len;
  }
  const at = (frac) => {
    let d = THREE.MathUtils.clamp(frac, 0, 1) * total;
    for (let i = 0; i < seg.length; i++) {
      if (d <= seg[i] || i === seg.length - 1) return segPose(wp[i], wp[i + 1], Math.min(1, d / seg[i]));
      d -= seg[i];
    }
    return segPose(wp[0], wp[1], 0);
  };
  // Heading and pitch come from a finite difference along the polyline, not
  // from the segment the truck happens to be on. Per-segment values are
  // constant inside a segment and jump at every vertex, and a bench arc is
  // 14 vertices of a curve -- which is what made the trucks snap their way
  // round instead of driving round.
  const f = THREE.MathUtils.clamp(fracAlongFromTo, 0, 1);
  const eps = Math.min(0.03, 6 / total);
  const back = at(Math.max(0, f - eps)), fwd = at(Math.min(1, f + eps));
  const run = Math.hypot(fwd[0] - back[0], fwd[2] - back[2]) || 1e-6;
  return {
    pos: at(f),
    heading: Math.atan2(fwd[0] - back[0], fwd[2] - back[2]),
    pitch: Math.atan2(fwd[1] - back[1], run),
  };
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
  // `y` is the elevation of whatever the truck is standing on: a bench, the
  // crusher pad, the dump. Defaults to grade for the surface facilities.
  let groundY = 0, standOn = 0.05;
  const at = (x, z, heading) => ({ pos: [x, groundY + standOn, z], heading });
  if (key === "fuel") {
    const [x, , z] = NODE_POSITIONS["fuel-01"];
    return slot < 2 ? at(x + (slot ? 2.5 : -2.5), z, 0) : at(x - 2.5 + 5 * (slot % 2), z - 8 * Math.floor(slot / 2), 0);
  }
  if (key === "repair") {
    const [x, , z] = NODE_POSITIONS["repair-01"];
    return slot < 2 ? at(x - 1, z + (slot ? 3.2 : -3.2), Math.PI / 2) : at(x - 13, z - 3.5 + 7 * (slot % 2), Math.PI / 2);
  }
  if (key === "junction") {
    const [x, y, z] = NODE_POSITIONS["junction-01"];
    groundY = y;
    // angles (in XZ) of the free sectors between the roads leaving the junction
    const JUNCTION_SLOTS = [2.4, 3.0, 2.0, 3.4, 0.1, -0.35];
    const a = JUNCTION_SLOTS[slot % JUNCTION_SLOTS.length];
    const r = 12 + 7 * Math.floor(slot / JUNCTION_SLOTS.length);
    return at(x + Math.cos(a) * r, z + Math.sin(a) * r, -a);
  }
  if (key === "crusher") return at(slot * 4.5, 24.5, Math.PI); // backed up to the hopper, at grade
  if (key === "crusher-q") return at(CRUSHER_BAY_X, 17 - 7.5 * slot, 0); // staging bay beside the road
  const D = ROAD_NODE_OVERRIDE["dump-01"];
  groundY = key === "dump" || key === "dump-q" ? D[1] : 0;
  if (key === "dump") return at(D[0] - WASTE_DIR[0], D[2] - WASTE_DIR[1], headingOf([-WASTE_DIR[0], -WASTE_DIR[1]]));
  if (key === "dump-q") {
    const back = 7.5 * (slot + 1);
    return at(D[0] - WASTE_DIR[0] * back - WASTE_DIR[1] * BAY_OFFSET, D[2] - WASTE_DIR[1] * back + WASTE_DIR[0] * BAY_OFFSET, headingOf(WASTE_DIR));
  }
  const [kind, exc] = key.split(":");
  const L = EXC_LAYOUT[exc];
  const F = NODE_POSITIONS[L.face];
  groundY = F[1];
  standOn = ROAD_Y;  // the loading spot and the shoulder bays are on the road
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
  pivot.userData.noMerge = true;
  // One material, not [tread, wall, wall]: a material array makes the renderer
  // issue one draw call per geometry group, so each tyre cost three instead of
  // one. Across six trucks that was 144 calls a frame for the wheels alone.
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 24), MAT.tire);
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
  bodyPivot.userData.noMerge = true; // tips while dumping
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

  // Tail lamps, lit whenever the truck is standing (see updateTrucks). Not in
  // colorMats: these stay red, they report motion, not twin state.
  const tailMat = glowMat(0xff2a1a, 0.35);
  for (const x of [-1.45, 1.45]) part(boxG(0.45, 0.22, 0.06), tailMat, x, 1.25, -3.12, root, false);
  group.userData.tailMat = tailMat;

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
  // Hidden from the overview camera (see updateTrucks) -- six moving labels
  // would clutter the wide shot, but up close they are how you tell which
  // truck the dispatch panel just reassigned.
  const label = makeLabel(id, 0.62);
  label.visible = false;
  scene.add(label);
  labelSprites[id] = label;
}
const TRUCK_LABEL_MAX_DIST = 90;

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

// Built once after the roads are in (they are added to `pickables` only after
// bootstrap). Rebuilding this inside the pointer handler allocated a fresh
// array on every mouse event for a list that never changes.
let pickableMeshes = [];
const refreshPickables = () => { pickableMeshes = pickables.map((p) => p.mesh); };

function pickAt(clientX, clientY) {
  pointer.x = (clientX / innerWidth) * 2 - 1;
  pointer.y = -(clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(pickableMeshes, true);
  return hits.length ? findPickableId(hits[0].object) : null;
}

let selectedId = null;
renderer.domElement.addEventListener("click", (ev) => {
  const id = pickAt(ev.clientX, ev.clientY);
  if (id) {
    selectedId = id;
    renderInspect(id);
  }
});

// Hover feedback, so it is discoverable that scene objects are clickable at
// all. The handler only records where the pointer is; the raycast itself runs
// once per frame from the render loop (see updateHover). Raycasting straight
// out of `pointermove` meant a full recursive walk of every pickable's
// descendants per *event* -- hundreds of times a second on a trackpad, all of
// it on the main thread, for a cursor shape.
let hoverX = 0, hoverY = 0, hoverDirty = false;
renderer.domElement.addEventListener("pointermove", (ev) => {
  hoverX = ev.clientX;
  hoverY = ev.clientY;
  hoverDirty = true;
});
function updateHover() {
  if (!hoverDirty) return;
  hoverDirty = false;
  renderer.domElement.style.cursor = pickAt(hoverX, hoverY) ? "pointer" : "default";
}

// Marker under whatever is selected. Trucks move, so it is repositioned every
// frame (see updateSelection) rather than placed once at click time.
const selectionRing = (() => {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.84, 1, 64),
    // forceSinglePass: a transparent DoubleSide material is otherwise drawn
    // twice, back faces then front, for a ring only ever seen from above.
    new THREE.MeshBasicMaterial({ color: 0x58a6ff, transparent: true, opacity: 0.95, side: THREE.DoubleSide, forceSinglePass: true, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  g.add(ring);
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(1, 48),
    new THREE.MeshBasicMaterial({ map: glowTexture, color: 0x58a6ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = -0.01;
  g.add(glow);
  g.visible = false;
  g.renderOrder = 4;
  scene.add(g);
  return g;
})();

const selectRadiusCache = {};
function selectRadius(id, mesh) {
  if (selectRadiusCache[id] === undefined) {
    const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
    selectRadiusCache[id] = Math.max(2.5, Math.max(size.x, size.z) * 0.62);
  }
  return selectRadiusCache[id];
}

function updateSelection(nowMs) {
  const mesh = selectedId && (truckMeshes[selectedId] || nodeMeshes[selectedId] || roadMeshes[selectedId]);
  if (!mesh) { selectionRing.visible = false; return; }
  selectionRing.visible = true;
  let radius;
  const bench = BENCH_RING[selectedId];
  if (bench) {
    selectionRing.position.set(bench.x, bench.y + 0.3, bench.z);
    radius = bench.r;
  } else if (roadMeshes[selectedId]) {
    // A road's bounding box is the whole road; ring it at its midpoint instead.
    const p = roadPose(selectedId, 0.5).pos;
    selectionRing.position.set(p[0], p[1] + 0.12, p[2]);
    radius = 6.5;
  } else {
    selectionRing.position.set(mesh.position.x, mesh.position.y + 0.14, mesh.position.z);
    radius = selectRadius(selectedId, mesh);
  }
  selectionRing.scale.setScalar(radius * (1 + 0.05 * Math.sin(nowMs / 320)));
}

// Attributes an operator may write. Marked in the card so it is obvious which
// rows are commands and which are the simulator's own readings.
const COMMAND_ATTRS = new Set(["closed", "forced_down", "assigned_excavator"]);
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

function renderInspect(id) {
  const body = document.getElementById("inspect-body");
  if (!id) { body.textContent = "Кликните по объекту на сцене."; return; }
  const t = world[id];
  if (!t) { body.textContent = "Нет данных."; return; }

  const attrs = [];
  for (const [k, v] of Object.entries(t.attributes || {})) {
    if (k.startsWith("_") || k === "name" || k === "kind") continue;
    attrs.push(`<tr class="${COMMAND_ATTRS.has(k) ? "cmd" : ""}"><td>${esc(k)}</td><td>${esc(v)}</td></tr>`);
  }
  const feats = [];
  for (const [k, f] of Object.entries(t.features || {})) {
    const p = f.properties || {};
    feats.push(`<tr><td>${esc(k)}</td><td>${esc(p.value)}${p.unit ? " " + esc(p.unit) : ""}</td></tr>`);
  }

  const group = (label, rows) =>
    rows.length ? `<tr><td class="grp" colspan="2">${label}</td></tr>${rows.join("")}` : "";

  body.innerHTML =
    `<div class="title">${esc(t.attributes?.name || id)}</div>` +
    `<div class="tid">${esc(NS)}:${esc(id)}</div>` +
    `<table>${group("Атрибуты · ⌁ команда", attrs)}${group("Признаки · телеметрия", feats)}</table>`;
}

// ---------------------------------------------------------------------------
// Scenario panel ("what-if")
// ---------------------------------------------------------------------------

const SCENARIOS = [
  { key: "exc1", title: "Экскаватор-01", label: "Отказ экскаватора-01", undo: "Восстановить экскаватор-01", things: ["excavator-01"], attr: "forced_down", on: true, off: false },
  { key: "exc2", title: "Экскаватор-02", label: "Отказ экскаватора-02", undo: "Восстановить экскаватор-02", things: ["excavator-02"], attr: "forced_down", on: true, off: false },
  { key: "roadA", title: "Основная дорога", label: "Закрыть основную дорогу (road-main-a)", undo: "Открыть road-main-a", things: ["road-main-a"], attr: "closed", on: true, off: false },
  { key: "roadB", title: "Резервная дорога", label: "Закрыть резервную дорогу (road-main-b)", undo: "Открыть road-main-b", things: ["road-main-b"], attr: "closed", on: true, off: false },
  { key: "crusher", title: "Дробилка", label: "Остановить дробилку", undo: "Запустить дробилку", things: ["crusher-01"], attr: "forced_down", on: true, off: false },
  { key: "shortage", title: "Нехватка самосвалов", label: "Вывести truck-05 и truck-06", undo: "Вернуть truck-05 и truck-06", things: ["truck-05", "truck-06"], attr: "forced_down", on: true, off: false },
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
  await Promise.all(scn.things.map((id) => writeAttribute(id, scn.attr, value)));
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
    const wrap = document.createElement("div");
    wrap.className = "scn";

    const head = document.createElement("div");
    head.className = "head";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = scn.title;
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = "активен";
    head.append(name, chip);

    const row = document.createElement("div");
    row.className = "row";
    const onBtn = document.createElement("button");
    onBtn.textContent = scn.label;
    onBtn.onclick = () => applyScenario(scn, true);
    const offBtn = document.createElement("button");
    offBtn.textContent = scn.undo;
    offBtn.onclick = () => applyScenario(scn, false);
    row.append(onBtn, offBtn);

    const delta = document.createElement("div");
    delta.className = "delta";

    wrap.append(head, row, delta);
    body.appendChild(wrap);
    scn.el = { wrap, onBtn, offBtn, delta };
  }
}
initScenarios(); // static DOM, doesn't need twin data -- clickable immediately on load

function renderScenarios() {
  for (const scn of SCENARIOS) {
    const el = scn.el;
    if (!el) continue;
    // Read back from the twins rather than from a local flag: after a reload,
    // or if someone flips the attribute straight from the Twins app, the
    // panel still tells the truth about what is currently perturbed.
    const active = scn.things.every((id) => aval(id, scn.attr) === scn.on);
    el.wrap.classList.toggle("active", active);
    el.onBtn.disabled = active;
    el.offBtn.disabled = !active;

    const before = activeSince[scn.key];
    if (active && before) {
      const now = kpiSnapshot();
      el.delta.textContent =
        `было ${num(before.throughput)} т/ч, план ${num(before.plan)}%` +
        ` → сейчас ${num(now.throughput)} т/ч, план ${num(now.plan)}%`;
    } else {
      el.delta.textContent = "";
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
      const dot = document.createElement("span");
      dot.className = "dot";
      const label = document.createElement("span");
      label.className = "id";
      label.textContent = id;
      const state = document.createElement("span");
      state.className = "st";
      const select = document.createElement("select");
      for (const exc of EXCAVATOR_IDS) {
        const opt = document.createElement("option");
        opt.value = exc; opt.textContent = exc.replace("excavator-", "Э-");
        select.appendChild(opt);
      }
      select.onchange = () => writeAttribute(id, "assigned_excavator", select.value);
      row.append(dot, label, state, select);
      body.appendChild(row);
    }
    const select = row.querySelector("select");
    // The dispatcher's own order (attribute), not the excavator the truck is
    // still working to (feature of the same name): reading the feature here
    // would snap the dropdown back for the second or two it takes the truck
    // to reach a safe point and actually switch.
    const ordered = aval(id, "assigned_excavator");
    const working = fval(id, "assigned_excavator");
    if (document.activeElement !== select && ordered && select.value !== ordered) select.value = ordered;

    // Those same seconds, made visible instead of looking like a dead control.
    const pending = Boolean(ordered && working && ordered !== working);
    row.classList.toggle("pending", pending);
    select.title = pending
      ? `Приказ: ${ordered}. Самосвал пока работает на ${working}, переключится на ближайшей безопасной точке цикла.`
      : "";

    const state = fval(id, "state");
    row.querySelector(".st").textContent = pending ? "переназначается" : (STATE_RU[state] ?? state ?? "");
    row.querySelector(".dot").style.background = `#${colorFor(state).toString(16).padStart(6, "0")}`;
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
// Автодиспетчер -- advisory fleet-allocation optimiser.
//
// The Concept names one decision: how to redistribute the trucks when
// something fails or a road closes, so the shift still makes its tonnage AND
// its copper grade. This module computes that answer instead of leaving it to
// the eye. It is strictly advisory -- it never writes to Ditto. The manual
// dispatch panel next to it is how the advice gets applied.
//
// Two halves:
//   1. An exact search. Only the COUNT per excavator matters, not which truck
//      goes where, so six trucks over three excavators is 28 arrangements --
//      all of them are evaluated, every tick. No heuristic, no learned model,
//      nothing a reader cannot recompute by hand.
//   2. Calibration against reality. The closed-form cycle below knows nothing
//      about queueing at the shovel, waiting at the junction, refuelling, or
//      the crusher backing up -- but the stand produces all of those. So the
//      realised cycle time is measured from the telemetry and used in place of
//      the theoretical one once there are enough samples.
//
// Every physical parameter is read from the twins (road lengths, bucket
// passes, shovel cycle, speeds, job efficiency); constants.py stays the single
// source of truth and nothing is duplicated here.
// ---------------------------------------------------------------------------

const EXC_LABEL = { "excavator-01": "Э-01", "excavator-02": "Э-02", "excavator-03": "Э-03" };

const cycleTheory = {}; // excId -> closed-form cycle seconds, last computed
const cycleObs = {};    // excId -> { ema, n } realised cycle seconds
const tripWatch = {};   // truckId -> { trips, atMs, exc } at its last completed trip

// The haul route as a list of legs, each leg being the roads that could carry
// it. Derived from the road twins' own from/to attributes rather than a second
// hardcoded copy of the topology (same source roadWaypoints uses).
function haulLegs(excId) {
  const face = EXCAVATOR_FACE[excId];
  const access = ROAD_IDS.find((r) => aval(r, "from") === face);
  if (!access) return null;
  const legs = [[access]];
  const onward = ROAD_IDS.filter((r) => aval(r, "from") === aval(access, "to"));
  if (onward.length) legs.push(onward);
  return legs;
}

function cycleModel(excId) {
  const face = EXCAVATOR_FACE[excId];
  const isWaste = aval(face, "ore_type") === "waste";
  const base = { excId, isWaste, usable: false };

  if (fval(excId, "state") === "down") return { ...base, reason: "в отказе" };
  if (fval(face, "state") === "depleted") return { ...base, reason: "забой отработан" };
  const legs = haulLegs(excId);
  if (!legs) return { ...base, reason: "нет маршрута" };

  const capacity = aval(TRUCK_IDS[0], "capacity_t") || 290;
  const loadS = (aval(excId, "passes_to_fill") || 4) * (aval(excId, "cycle_time_s") || 29);
  const spotS = aval("section-01", "spot_s") ?? 30;
  const dumpS = aval("section-01", "dump_s") ?? 90;
  const eff = aval("section-01", "job_efficiency") || 0.8333;
  const vLoaded = aval("section-01", "speed_loaded_kmh") || 25;
  const vEmpty = aval("section-01", "speed_empty_kmh") || 35;

  // Grade costs speed, and only uphill: each road twin publishes the average
  // grade derived from its two endpoints' elevations, and the loaded
  // direction is always the climb out of the pit. Mirrors haul_leg() in
  // simulator.py -- if the two drift apart the advice stops matching the mine.
  const penalty = aval("section-01", "grade_speed_penalty") ?? 0.08;
  const legSeconds = (r) => {
    const km = aval(r, "length_km") ?? 0;
    const g = aval(r, "avg_grade_pct") ?? 0;
    const up = Math.max(0.5, 1 - g * penalty);
    return ((km / (vLoaded * up)) + (km / vEmpty)) * 3600 / eff;
  };

  let travelS = 0;
  for (const leg of legs) {
    const open = leg.filter((r) => fval(r, "state") !== "closed");
    if (!open.length) return { ...base, reason: `закрыта ${leg.join(" и ")}` };
    // A truck takes whichever open road on this leg is *quickest*, which is
    // not always the shortest once the grade differs between them: the backup
    // main is nearly twice as long but climbs half as steeply.
    travelS += Math.min(...open.map(legSeconds));
  }
  const theoreticalS = loadS + spotS + travelS + dumpS;
  cycleTheory[excId] = theoreticalS;

  const obs = cycleObs[excId];
  const calibrated = Boolean(obs && obs.n >= 3);
  return {
    ...base,
    usable: true,
    grade: isWaste ? 0 : (fval(face, "grade") ?? 0),
    capacity,
    serviceS: loadS + spotS,         // how often the shovel can turn a truck round
    cycleS: calibrated ? obs.ema : theoreticalS,
    calibrated,
  };
}

// A truck's trips_total ticking up is one completed cycle. Timed in real
// milliseconds, converted to simulated seconds through the section's own
// sim_speedup, and attributed to the excavator it was actually working.
function observeCycles(nowMs) {
  const speedup = fval("section-01", "sim_speedup") || 10;
  for (const id of TRUCK_IDS) {
    const trips = fval(id, "trips_total");
    const exc = fval(id, "assigned_excavator");
    if (typeof trips !== "number" || !exc) continue;

    const prev = tripWatch[id];
    if (!prev) { tripWatch[id] = { trips, atMs: nowMs, exc, primed: false }; continue; }
    if (trips === prev.trips) continue; // still mid-cycle
    const laps = Math.max(1, trips - prev.trips);
    const simS = (((nowMs - prev.atMs) / 1000) * speedup) / laps;
    tripWatch[id] = { trips, atMs: nowMs, exc, primed: true };

    // The very first interval after the page loads runs from an arbitrary
    // moment mid-cycle to the next tip, so it is a fragment of a cycle, not a
    // cycle. Seeding the average with it made measured times come out ~35%
    // SHORTER than theory, which is backwards -- theory ignores queueing and
    // must be the optimistic one. Only intervals between two observed tips
    // count.
    if (!prev.primed) continue;
    if (prev.exc !== exc) continue;                  // reassigned mid-cycle: not a clean sample
    const theory = cycleTheory[exc];
    if (!theory || simS <= 0 || simS > theory * 5) continue; // a stall or a repair, not a cycle

    const obs = cycleObs[exc] || (cycleObs[exc] = { ema: simS, n: 0 });
    obs.ema += (simS - obs.ema) * 0.3;
    obs.n++;
  }
}

// What the crusher can actually take. Ore delivered beyond this does not
// become plan -- it becomes a growing stockpile -- so piling every truck onto
// the richest face is not the win a raw tonnage figure makes it look.
function crusherIntake() {
  const planT = fval("shift-01", "plan_tonnes");
  const hours = aval("shift-01", "shift_hours");
  if (planT > 0 && hours > 0) return planT / hours;
  return aval("crusher-01", "rated_tph_max") ?? Infinity;
}

function evaluateSplit(models, counts, intake) {
  let oreTph = 0, gradeTonnes = 0, wasteTph = 0;
  for (const exc of EXCAVATOR_IDS) {
    const m = models[exc];
    if (!m.usable) continue;
    const n = counts[exc] || 0;
    // Trucks and the shovel each cap the rate; the smaller cap is the rate.
    const tph = n > 0 ? Math.min((n * m.capacity) / m.cycleS, m.capacity / m.serviceS) * 3600 : 0;
    if (m.isWaste) wasteTph += tph;
    else { oreTph += tph; gradeTonnes += tph * m.grade; }
  }
  return {
    oreTph,
    wasteTph,
    useful: Math.min(oreTph, intake),
    grade: oreTph > 0 ? gradeTonnes / oreTph : 0,
  };
}

// Priority, in order:
//   1. hold the grade floor (below it the blend is off-spec, nothing else
//      matters); if no split can, maximise grade and say so;
//   2. feed the crusher as fully as it can take;
//   3. put whatever the crusher cannot use onto stripping rather than into a
//      stockpile -- this is what stops the answer being "five trucks on the
//      best face", since ore tipped beyond the crusher's appetite is not plan,
//      it is just a growing pile;
//   4. blend as CLOSE to the floor as possible from above.
//
// That last rule is deliberately not "maximise grade". A mine blends to hit
// its target, not to beat it: grade delivered above plan is rich ore spent for
// nothing, and burning the high-grade face first shortens the time the section
// can keep meeting plan at all. It is also what keeps this module's advice
// consistent with the ore-quality module next to it, which tells the
// dispatcher to shift trucks onto the leaner face whenever grade allows.
function betterSplit(a, b) {
  if (!b) return true;
  if (a.meets !== b.meets) return a.meets;
  if (!a.meets) {
    // Grade floor out of reach (one ore face left, say). Best grade still
    // wins, but with a single source every split grades the same, and then
    // tonnage has to decide -- otherwise the tie is broken by enumeration
    // order and the module cheerfully advises pulling trucks OFF ore in the
    // middle of a shovel outage. Caught exactly that way on the stand.
    if (Math.abs(a.grade - b.grade) > 1e-6) return a.grade > b.grade;
    if (Math.abs(a.useful - b.useful) > 1) return a.useful > b.useful;
    return a.wasteTph > b.wasteTph;
  }
  if (Math.abs(a.useful - b.useful) > 1) return a.useful > b.useful;
  if (Math.abs(a.wasteTph - b.wasteTph) > 1) return a.wasteTph > b.wasteTph;
  return a.gradeMargin < b.gradeMargin;
}

function optimalSplit(models, truckCount, gradeMin, intake) {
  const usable = EXCAVATOR_IDS.filter((exc) => models[exc].usable);
  if (!usable.length || truckCount <= 0) return null;
  const hasWaste = usable.some((exc) => models[exc].isWaste);

  const splits = [];
  const walk = (i, left, acc) => {
    if (i === usable.length - 1) { splits.push({ ...acc, [usable[i]]: left }); return; }
    for (let n = 0; n <= left; n++) walk(i + 1, left - n, { ...acc, [usable[i]]: n });
  };
  walk(0, truckCount, {});

  let best = null, relaxed = null;
  for (const counts of splits) {
    const m = evaluateSplit(models, counts, intake);
    const candidate = {
      counts, ...m,
      meets: m.grade >= gradeMin - 1e-9,
      gradeMargin: m.grade - gradeMin, // how much rich ore the blend gives away
    };
    if (betterSplit(candidate, relaxed)) relaxed = candidate;
    // Stripping must not stop: with no trucks on waste the pit cannot advance,
    // however good the ore numbers look this hour.
    const keepsStripping = !hasWaste || usable.some((exc) => models[exc].isWaste && counts[exc] > 0);
    if (keepsStripping && betterSplit(candidate, best)) best = candidate;
  }
  return best || relaxed;
}

function renderAutodispatch() {
  const body = document.getElementById("autodispatch-body");
  observeCycles(performance.now());

  const models = {};
  for (const exc of EXCAVATOR_IDS) models[exc] = cycleModel(exc);
  const usable = EXCAVATOR_IDS.filter((exc) => models[exc].usable);

  const active = TRUCK_IDS.filter((id) => fval(id, "state") !== "down");
  if (!usable.length || !active.length) {
    body.innerHTML = `<div class="note warn">Распределять нечего: нет доступных экскаваторов или самосвалов.</div>`;
    return;
  }

  // Compared against the dispatcher's own orders, not against where the trucks
  // happen to be this second -- the orders are what the panel next door shows
  // and what the viewer would actually change.
  const current = {};
  let stranded = 0;
  for (const id of active) {
    const ordered = aval(id, "assigned_excavator");
    if (models[ordered]?.usable) current[ordered] = (current[ordered] || 0) + 1;
    else stranded++;
  }

  const gradeMin = fval("shift-01", "plan_grade_min") ?? 0;
  const intake = crusherIntake();
  const now = evaluateSplit(models, current, intake);
  const best = optimalSplit(models, active.length, gradeMin, intake);
  if (!best) { body.innerHTML = `<div class="note warn">Не удалось рассчитать распределение.</div>`; return; }

  const splitText = (counts) => usable.map((exc) => `${EXC_LABEL[exc]}&nbsp;${counts[exc] || 0}`).join(" · ");
  // The headline figure is what actually reaches the crusher, not what the
  // trucks could tip if it had infinite appetite.
  const rate = (m) => `${num(m.useful)} т/ч · ${num(m.grade, 3)}%&nbsp;Cu`;
  const gain = best.useful - now.useful;

  const moves = usable
    .map((exc) => ({ exc, d: (best.counts[exc] || 0) - (current[exc] || 0) }))
    .filter((m) => m.d !== 0)
    .map((m) => `${EXC_LABEL[m.exc]} ${m.d > 0 ? "+" : "−"}${Math.abs(m.d)}`);

  const cycles = usable
    .map((exc) => `${EXC_LABEL[exc]} ${num(models[exc].cycleS / 60, 1)}&nbsp;мин ${models[exc].calibrated ? "факт" : "расчёт"}`)
    .join(" · ");

  const notes = [];
  for (const exc of EXCAVATOR_IDS) {
    if (!models[exc].usable) notes.push(`${EXC_LABEL[exc]} недоступен: ${esc(models[exc].reason)}`);
  }
  if (stranded) notes.push(`${stranded} самосв. назначено на недоступный экскаватор`);
  if (!best.meets) {
    notes.push(`План по содержанию ${num(gradeMin, 2)}% недостижим ни при каком раскладе — показан максимум`);
  }
  if (best.oreTph > intake + 1) {
    notes.push(`Подача ${num(best.oreTph)} т/ч выше приёма дробилки ${num(intake)} т/ч — излишек уйдёт на склад`);
  }
  // While the crusher is stopped nothing the trucks tip becomes plan -- it
  // becomes stockpile. Saying "2 850 т/ч" through a crusher outage would be a
  // straight-up false claim on screen.
  if (fval("crusher-01", "state") === "down") {
    const room = (aval("stockpile-01", "capacity_t") ?? 0) - (fval("stockpile-01", "tonnes_current") ?? 0);
    notes.push(
      `Дробилка остановлена — подача идёт на склад, план смены не растёт` +
      (room > 0 ? ` (свободно ${num(room)} т)` : ` (склад полон, самосвалы встанут)`),
    );
  }

  body.innerHTML = `
    <div class="line"><span class="tag">Сейчас</span><span class="split">${splitText(current)}</span><span class="num">${rate(now)}</span></div>
    <div class="line"><span class="tag">Оптимум</span><span class="split">${splitText(best.counts)}</span><span class="num">${rate(best)}</span>${
      gain > 1 ? `<span class="gain">+${num(gain)} т/ч</span>` : ""
    }</div>
    <div class="line"><span class="tag">Цикл</span><span class="num">${cycles}</span></div>
    <div class="note">${
      moves.length
        ? `Что сделать: ${moves.join(", ")} — в панели «Диспетчеризация».`
        : "Парк распределён оптимально, менять нечего."
    }</div>
    ${notes.map((n) => `<div class="note warn">${n}</div>`).join("")}
  `;
}

// ---------------------------------------------------------------------------
// Live scene labels. Each twin's own headline number sits above it, so the
// scene can be read without clicking through objects one at a time.
// ---------------------------------------------------------------------------

const STATE_RU = {
  idle: "простой", active: "в работе", loading: "погрузка", hauling: "рейс",
  returning: "порожняком", dumping: "разгрузка", queued_at_excavator: "в очереди",
  queued_at_crusher: "в очереди", crushing: "дробит", queued_stockpile_full: "склад полон",
  blocked_road: "дорога закрыта", blocked_at_junction: "блок на развязке", blocked: "блок",
  waiting_excavator_down: "ждёт экскаватор", down: "отказ", refueling: "заправка",
  serving: "обслуживает", open: "открыта", closed: "закрыта", busy: "занята",
  running: "работает", stopped: "стоит",
};

const num = (v, digits = 0) =>
  typeof v === "number" ? v.toLocaleString("ru-RU", { maximumFractionDigits: digits }) : "—";

// -> [subtitle, dotColorHex] for the label above `id`, or null to leave it as is.
function labelInfo(id) {
  const state = fval(id, "state");
  const ru = STATE_RU[state] ?? state ?? "";
  const dot = state === undefined ? null : colorFor(state);
  if (id.startsWith("truck-")) return [`${ru} · ${num(fval(id, "payload_t"))} т`, dot];
  if (id.startsWith("excavator-")) return [`${ru} · ${num(fval(id, "tonnes_loaded_shift"))} т`, dot];
  if (id.startsWith("road-")) {
    return [`${ru} · ${num(aval(id, "length_km"), 1)} км · ${num(fval(id, "trucks_on_road"))} маш.`, dot];
  }
  if (BENCH_TWINS[id]) {
    return [`отм. ${num(aval(id, "elevation_m"))} м · ${num(fval(id, "tonnes_mined_shift"))} т за смену`, dot];
  }
  switch (id) {
    case "face-ore-01":
    case "face-ore-02":
      return [`${num(fval(id, "grade"), 2)}% Cu · запас ${num(fval(id, "reserves_t") / 1000, 1)} тыс. т`, dot];
    case "face-waste-01":
      return [`вскрыша · запас ${num(fval(id, "reserves_t") / 1000, 1)} тыс. т`, dot];
    case "crusher-01":
    case "conveyor-01":
      return [`${num(fval(id, "throughput_tph"))} т/ч · ${ru}`, dot];
    case "stockpile-01": {
      const t = fval(id, "tonnes_current") ?? 0;
      const cap = aval(id, "capacity_t") || 1;
      return [`${num(t)} т · ${num((t / cap) * 100)}% ёмкости`, colorFor(t / cap > 0.92 ? "closed" : "active")];
    }
    case "dump-01":
      return [`${num(fval(id, "tonnes_shift"))} т за смену`, null];
    case "fuel-01":
      return [`${ru} · очередь ${num(fval(id, "trucks_queued"))}`, dot];
    case "repair-01":
      return [`${ru} · в ремонте ${num(fval(id, "units_in_repair"))}`, dot];
    case "junction-01":
      return [`маршрут ${aval(id, "elevation_m") ?? ""} м · ${fval(id, "route_main") || "—"}`, dot];
    default:
      return null;
  }
}

function updateLabels() {
  for (const [id, sprite] of Object.entries(labelSprites)) {
    const info = labelInfo(id);
    if (info) sprite.userData.set(sprite.userData.title, info[0], info[1]);
    // Keep labels legible across the whole zoom range: without this they are
    // billboards in world units, so they swallow the screen up close and turn
    // into unreadable slivers from the overview camera.
    const dist = sprite.position.distanceTo(camera.position);
    // Five road labels on top of the fixed plant make the overview unreadable,
    // so they only come in when the camera is close -- or whenever the road is
    // closed, which is exactly the moment the viewer needs to see which one.
    if (id.startsWith("road-")) sprite.visible = dist < 100 || fval(id, "state") === "closed";
    // A bench label is background information next to the machines working on
    // it, so it only comes in once the camera is close enough to be reading
    // the bench rather than the whole section.
    if (id.startsWith("bench-")) sprite.visible = dist < 165;
    const k = THREE.MathUtils.clamp(dist / 62, 0.33, 2.4);
    const w = sprite.userData.baseW * k;
    sprite.scale.set(w, (w * LABEL_H) / LABEL_W, 1);
  }
}

// ---------------------------------------------------------------------------
// KPI bar
// ---------------------------------------------------------------------------

// Status is carried by a glyph as well as a colour, so the bar still reads
// on a greyscale screenshot and to a colour-blind viewer.
const STAT_MARK = { warn: "!", bad: "✕" };

function statHTML({ value, label, level = null, bar }) {
  const cls = level ? ` ${level}` : "";
  const mark = STAT_MARK[level] ? `<span class="mark">${STAT_MARK[level]}</span>` : "";
  const barHTML =
    bar === undefined ? "" : `<span class="bar${cls}"><i style="width:${Math.max(0, Math.min(100, bar))}%"></i></span>`;
  return `<div class="stat"><span class="v${cls}">${mark}${value}</span><span class="l">${label}</span>${barHTML}</div>`;
}

function renderKPI() {
  const f = (id) => fval("shift-01", id);
  const shiftMin = (aval("shift-01", "shift_hours") || 12) * 60;
  const remaining = f("time_remaining_min");
  const planPct = f("plan_completion_pct");
  const grade = f("grade_actual");
  const gradeMin = f("plan_grade_min");
  const tph = fval("crusher-01", "throughput_tph");
  const trucks = fval("section-01", "trucks_active");

  // Plan is judged against the clock, not against 100%: 40% of the plan at
  // the halfway mark is on pace, the same 40% with an hour left is not. This
  // is the whole reason a dispatcher looks at this bar.
  const elapsedPct = remaining === undefined ? undefined : 100 * (1 - remaining / shiftMin);
  const planLevel =
    planPct === undefined || elapsedPct === undefined ? null
      : planPct >= elapsedPct - 2 ? "ok" : planPct >= elapsedPct - 12 ? "warn" : "bad";
  const gradeLevel =
    !grade || gradeMin === undefined ? null
      : grade >= gradeMin ? "ok" : grade >= gradeMin - 0.02 ? "warn" : "bad";
  const tphLevel = tph === undefined ? null : tph > 0 ? "ok" : "bad";
  const trucksLevel =
    trucks === undefined ? null : trucks === TRUCK_IDS.length ? "ok" : trucks > 0 ? "warn" : "bad";

  document.getElementById("kpi").innerHTML = [
    statHTML({
      value: planPct === undefined ? "—" : `${num(planPct, 1)}%`,
      label: `план смены · ${num(f("tonnes_actual"))} из ${num(f("plan_tonnes"))} т`,
      level: planLevel,
      bar: planPct ?? 0,
    }),
    statHTML({
      value: grade === undefined ? "—" : `${num(grade, 3)}%`,
      label: `Cu в подаче · план ≥ ${num(gradeMin, 2)}%`,
      level: gradeLevel,
    }),
    statHTML({
      value: tph === undefined ? "—" : `${num(tph)}`,
      label: `т/ч дробилка · паспорт ${num(aval("crusher-01", "rated_tph_min"))}–${num(aval("crusher-01", "rated_tph_max"))}`,
      level: tphLevel,
    }),
    statHTML({
      value: trucks === undefined ? "—" : `${trucks}/${TRUCK_IDS.length}`,
      label: "самосвалов в работе",
      level: trucksLevel,
    }),
    statHTML({
      value: `№${f("shift_number") ?? "—"}`,
      label: `смена · осталось ${num(remaining)} мин`,
      bar: elapsedPct ?? 0,
    }),
  ].join("");
}

// ---------------------------------------------------------------------------
// Chrome toggle. Six opaque panels cover a good third of the viewport, and
// the thing worth looking at is behind them -- so they can be dismissed, by
// the button or by pressing H (Cyrillic "р" sits on the same key).
// ---------------------------------------------------------------------------

const chromeToggle = document.getElementById("chrome-toggle");
function setBare(bare) {
  document.body.classList.toggle("bare", bare);
  chromeToggle.textContent = bare ? "Показать панели (H)" : "Скрыть панели (H)";
}
chromeToggle.onclick = () => setBare(!document.body.classList.contains("bare"));
addEventListener("keydown", (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const tag = ev.target?.tagName;
  if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA") return;
  if ("hHрР".includes(ev.key)) setBare(!document.body.classList.contains("bare"));
});

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

// Status colours are picked for contrast on a dark UI. Sprayed at full
// saturation over a whole truck body they read as toys, so painted surfaces
// get a muted version of the same hue -- still unmistakably green/amber/red,
// but the value of real equipment paint. Lamps and stripes keep the vivid
// colour, which is what makes them read as lamps.
const _paint = new THREE.Color();
const mutedPaintCache = new Map();
function mutedPaint(hex) {
  let out = mutedPaintCache.get(hex);
  if (out === undefined) {
    const hsl = {};
    _paint.setHex(hex, THREE.SRGBColorSpace).getHSL(hsl, THREE.SRGBColorSpace);
    _paint.setHSL(hsl.h, hsl.s * 0.5, Math.min(0.52, hsl.l * 0.88), THREE.SRGBColorSpace);
    out = _paint.getHex(THREE.SRGBColorSpace);
    mutedPaintCache.set(hex, out);
  }
  return out;
}

function setGroupColor(group, hex) {
  const muted = mutedPaint(hex);
  for (const mat of group?.userData.colorMats || []) {
    if (mat.userData.glow) {
      mat.color.setHex(hex);
      mat.emissive.setHex(hex);
    } else {
      mat.color.setHex(muted);
    }
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

const dustAccum = {}; // truck id -> metres travelled since the last wheel puff
const dumpDust = {};  // truck id -> seconds since the last tipping puff
const digDust = {};   // excavator id -> seconds since the last digging puff

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
      pose = {
        pos: [road.pos[0] + rx * LANE_OFFSET, road.pos[1], road.pos[2] + rz * LANE_OFFSET],
        heading,
        pitch: returning ? -road.pitch : road.pitch,
      };
    } else {
      const slot = slotsTaken[key] = (slotsTaken[key] ?? -1) + 1;
      pose = parkedPose(key, slot);
    }

    _delta.copy(mesh.position);
    mesh.position.lerp(_target.set(pose.pos[0], pose.pos[1], pose.pos[2]), posAlpha);
    _delta.subVectors(mesh.position, _delta);
    mesh.rotation.y += wrapAngle(pose.heading - mesh.rotation.y) * turnAlpha;
    // Nose up the ramp and down it again. Without this a truck climbing a
    // 10% grade stays dead level and the climb reads as a glitch.
    mesh.rotation.x += ((pose.pitch ?? 0) - mesh.rotation.x) * turnAlpha;

    // Roll wheels by distance travelled along the truck's own forward axis.
    const fwd = _delta.x * Math.sin(mesh.rotation.y) + _delta.z * Math.cos(mesh.rotation.y);
    if (Math.abs(fwd) > 0.0005) {
      const roll = (fwd / (WHEEL_RADIUS * TRUCK_SCALE)) * WHEEL_ROLL_SCALE;
      for (const wheel of mesh.userData.wheels) wheel.rotation.x += roll;
    }

    mesh.userData.tailMat.emissiveIntensity = moving ? 0.35 : 2.8;

    const label = labelSprites[id];
    label.position.set(mesh.position.x, mesh.position.y + 6.6, mesh.position.z);
    label.visible = camera.position.distanceTo(mesh.position) < TRUCK_LABEL_MAX_DIST;

    const sinY = Math.sin(mesh.rotation.y), cosY = Math.cos(mesh.rotation.y);
    // Wheel dust is metered by distance covered, not by time, so a plume's
    // density follows the truck's actual speed and a parked truck raises none.
    dustAccum[id] = (dustAccum[id] ?? 0) + Math.abs(fwd);
    if (dustAccum[id] > 1.3) {
      dustAccum[id] = 0;
      const loaded = (fval(id, "payload_t") ?? 0) > 1;
      plumes.spawn(mesh.position.x - sinY * 2.6, 0.3, mesh.position.z - cosY * 2.6, {
        s0: 1.2, s1: loaded ? 7.5 : 5.5, lifeS: 2.3, a: loaded ? 0.46 : 0.34, rise: 0.6,
      });
    }
    // Tipping throws up far more than hauling does.
    if (m.state === "dumping") {
      dumpDust[id] = (dumpDust[id] ?? 0) + dtS;
      if (dumpDust[id] > 0.11) {
        dumpDust[id] = 0;
        plumes.spawn(mesh.position.x - sinY * 4.4, 0.5, mesh.position.z - cosY * 4.4, {
          s0: 1.8, s1: 9, lifeS: 2.8, a: 0.4, rise: 1.4,
        });
      }
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
    if (state === "loading") {
      digDust[id] = (digDust[id] ?? 0) + dtS;
      if (digDust[id] > 0.3) {
        digDust[id] = 0;
        const P = EXC_LAYOUT[id].pile;
        plumes.spawn(P[0], 1.2, P[2], { s0: 1.2, s1: 5.5, lifeS: 2.4, a: 0.24, rise: 0.9 });
      }
    }
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
    // An open haul road has an ordinary painted centre line; only a road that
    // is out of service lights its line up. A permanently glowing green strip
    // looked like track markings in a racing game and, worse, spent the
    // scene's "something is wrong" signal on the normal case.
    const open = state === "open";
    for (const mat of roadMeshes[id]?.userData.colorMats || []) {
      mat.color.setHex(open ? 0x96885f : colorFor(state));
      mat.emissive.setHex(open ? 0x000000 : colorFor(state));
      mat.emissiveIntensity = open ? 0 : 0.9;
    }
    updateBeacon(id, state === "closed", now);
    updateBarrier(id, state === "closed", now);
  }
  for (const belt of belts) if (belt.isRunning()) belt.tex.offset.y -= belt.speed * dtS;

  const stock = fval("stockpile-01", "tonnes_current") ?? 0;
  nodeMeshes["stockpile-01"].userData.pile.scale.setScalar(0.4 + Math.min(1.6, Math.cbrt(stock / 500)));
  const dumpFill = (fval("dump-01", "tonnes_current") ?? 0) / (aval("dump-01", "capacity_t") || 1);
  nodeMeshes["dump-01"].userData.mound.scale.y = 0.55 + 0.9 * Math.min(1, Math.max(0, dumpFill));

  animateDust(dtS);
  plumes.update(dtS);
  updateSelection(now);
  updateHover();

  if (now - lastUIUpdateMs >= UI_UPDATE_MS) {
    lastUIUpdateMs = now;
    renderKPI();
    renderScenarios();
    renderDispatch();
    renderRecommendation();
    renderAutodispatch();
    renderInspect(selectedId); // keep the open twin panel live, not a click-time snapshot
    updateLabels();
  }

  controls.update();
  composer.render();
}

window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  // Point sprites are sized in pixels, so the dust shader's own copy of the
  // viewport height has to follow the window or puffs change size on resize.
  plumes.uniforms.uScale.value = innerHeight * 0.5 * Math.min(devicePixelRatio, 2);
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
    refreshPickables(); // roads join `pickables` only here
    // After every object exists, including the roads and closure barriers
    // built just above. Order matters: the shadow flags are part of the merge
    // key, so they have to be final before anything is merged.
    pruneShadowCasters(scene);
    const staticGroups = [
      pitGroup, stackerGroup,
      ...["face-ore-01", "face-ore-02", "face-waste-01", "crusher-01", "conveyor-01",
          "stockpile-01", "dump-01", "fuel-01", "repair-01", "junction-01"].map((id) => nodeMeshes[id]),
      ...ROAD_IDS.map((id) => roadMeshes[id]),
      ...ROAD_IDS.map((id) => roadBarriers[id]?.group),
      // Vehicles too: only the wheels, the tipping body and the excavator
      // rig actually move, everything else is welded to the hull.
      ...TRUCK_IDS.map((id) => truckMeshes[id]),
      ...EXCAVATOR_IDS.map((id) => nodeMeshes[id]),
      // Each rigid sub-body is merged as its own root: its parts do not move
      // relative to it, only it moves relative to the machine.
      ...TRUCK_IDS.map((id) => truckMeshes[id].userData.bodyPivot),
      ...EXCAVATOR_IDS.flatMap((id) => Object.values(nodeMeshes[id].userData.rig)),
    ];
    let mergedParts = 0;
    for (const group of staticGroups) if (group) mergedParts += mergeStaticGroup(group);
    console.info(`scene: merged ${mergedParts} static parts`);
    connectSSE();
    tick();
  })
  .catch((err) => {
    document.getElementById("inspect-body").textContent = "Не удалось получить данные из Ditto: " + err.message;
    console.error(err);
  });
