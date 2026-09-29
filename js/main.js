import * as THREE from 'three';
import { Game } from './sim/game.js';
import { Arena } from './render/arena.js';
import { PlayerView, BallView, loadPlayerAsset } from './render/players.js';
import { CameraDirector, CAMERA_MODES } from './render/cameras.js';
import { Hud } from './ui/hud.js';
import { Editor, allTeams } from './ui/editor.js';
import { overall } from './data/teams.js';

const SIM_DT = 1 / 60;
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ renderer
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07080c);
scene.fog = new THREE.Fog(0x07080c, 45, 90);
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);

scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a2a1a, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 2.1);
key.position.set(6, 22, -8);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -18, right: 18, top: 12, bottom: -12, near: 5, far: 50 });
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
scene.add(key);
for (const x of [-10, 0, 10]) {
  const l = new THREE.PointLight(0xfff1dd, 40, 30, 1.6);
  l.position.set(x, 14, 0);
  scene.add(l);
}

const director = new CameraDirector(camera, canvas);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ------------------------------------------------------------ state
let asset = null;
let game = null;
let arena = null;
let views = [];
let ballView = null;
let paused = false;
let speed = 1;
let simToEnd = false;
let acc = 0;
let showLabels = true;
let selected = null;

const hud = new Hud({ onSelectPlayer: (id) => selectPlayer(id) });

function selectPlayer(id) {
  selected = id ? game.players.find((p) => p.id === id) || null : null;
  for (const v of views) v.setSelected(v.p === selected);
  hud.select(selected);
}

// ------------------------------------------------------------ setup screen
let teams = allTeams();
const picks = [0, 1];
const editor = new Editor((saved) => {
  teams = allTeams();
  const idx = teams.findIndex((t) => t.key === saved.key);
  if (idx >= 0) {
    const side = editor.side ?? 0;
    picks[side] = idx;
  }
  renderSetup();
});

function teamPreview(t) {
  const starters = t.players.slice(0, 5);
  const avg = Math.round(t.players.slice(0, 8).reduce((s, p) => s + overall(p), 0) / 8);
  return `<div class="banner" style="background:linear-gradient(90deg,${t.primary},${t.secondary})"></div>
    ${starters.map((p) => `<div class="row"><span>${p.pos} #${p.num} ${p.name}</span><span>${overall(p)}</span></div>`).join('')}
    <div class="row"><span>Top-8 avg${t.edited ? ' · edited' : ''}</span><span>${avg}</span></div>`;
}

function renderSetup() {
  document.querySelectorAll('.team-pick').forEach((el) => {
    const side = +el.dataset.side;
    const sel = el.querySelector('.team-select');
    sel.innerHTML = teams.map((t, i) => `<option value="${i}">${t.name}${t.edited ? ' *' : ''}</option>`).join('');
    sel.value = picks[side];
    sel.onchange = () => { picks[side] = +sel.value; renderSetup(); };
    el.querySelector('.team-preview').innerHTML = teamPreview(teams[picks[side]]);
    el.querySelector('.edit-btn').onclick = () => { editor.side = side; editor.open(teams[picks[side]]); };
  });
}

function openSetup() {
  teams = allTeams();
  renderSetup();
  $('setup').classList.remove('hidden');
  paused = true;
}

$('btn-start').onclick = () => {
  if (picks[0] === picks[1]) {
    alert('Pick two different teams.');
    return;
  }
  const seedText = $('seed-input').value.trim();
  const seed = seedText ? [...seedText].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) : undefined;
  startGame(teams[picks[0]], teams[picks[1]], +$('quarter-len').value, seed);
  $('setup').classList.add('hidden');
};
$('btn-new').onclick = openSetup;

// ------------------------------------------------------------ game lifecycle
function startGame(home, away, periodLen, seed) {
  for (const v of views) v.dispose(scene);
  views = [];
  if (arena) arena.dispose();
  selected = null;
  game = new Game(home, away, { periodLen, seed });
  arena = new Arena(scene, game.teams[0], game.teams[1]);
  if (!ballView) ballView = new BallView(scene);
  for (const p of game.players) views.push(new PlayerView(scene, p, game.teams[p.team], asset, showLabels));
  hud.attach(game);
  hud.select(null);
  paused = false;
  simToEnd = false;
  acc = 0;
  lastScore = 0;
  updatePlayButton();
  $('btn-simend').classList.remove('on');
}

// ------------------------------------------------------------ controls
function updatePlayButton() {
  $('btn-play').textContent = paused ? '▶' : '❚❚';
  $('btn-play').title = paused ? 'Play (Space)' : 'Pause (Space)';
}
$('btn-play').onclick = () => { paused = !paused; updatePlayButton(); };
document.querySelectorAll('#speeds button').forEach((b) => {
  b.onclick = () => {
    speed = +b.dataset.speed;
    simToEnd = false;
    $('btn-simend').classList.remove('on');
    document.querySelectorAll('#speeds button').forEach((x) => x.classList.toggle('active', x === b));
  };
});
$('btn-simend').onclick = () => {
  simToEnd = !simToEnd;
  $('btn-simend').classList.toggle('on', simToEnd);
  if (simToEnd) { paused = false; updatePlayButton(); }
};
const camSel = $('camera-select');
camSel.innerHTML = CAMERA_MODES.map((m) => `<option value="${m.key}">${m.label}</option>`).join('');
camSel.onchange = () => director.setMode(camSel.value);
$('labels-toggle').onchange = (e) => {
  showLabels = e.target.checked;
  for (const v of views) v.setLabels(showLabels);
};
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || !game) return;
  if (e.code === 'Space') { e.preventDefault(); paused = !paused; updatePlayButton(); }
  if (e.key === 'c' || e.key === 'C') {
    const i = CAMERA_MODES.findIndex((m) => m.key === director.mode);
    const next = CAMERA_MODES[(i + 1) % CAMERA_MODES.length].key;
    camSel.value = next;
    director.setMode(next);
  }
  if (e.key === 'Escape') selectPlayer(null);
});

// Click a player to inspect them.
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || !game) return;
  if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return; // was a drag
  const r = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(views.map((v) => v.hit), false);
  selectPlayer(hits.length ? hits[0].object.userData.playerId : null);
});

// ------------------------------------------------------------ main loop
let last = performance.now();
let lastScore = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const realDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  let simAdvanced = 0;
  if (game && !paused) {
    if (simToEnd && !game.over) {
      const t0 = performance.now();
      while (!game.over && performance.now() - t0 < 24) {
        for (let i = 0; i < 120 && !game.over; i++) { game.step(SIM_DT); simAdvanced += SIM_DT; }
      }
      if (game.over) { simToEnd = false; $('btn-simend').classList.remove('on'); }
    } else {
      acc += realDt * speed;
      let n = 0;
      while (acc >= SIM_DT && n < 720) { game.step(SIM_DT); acc -= SIM_DT; simAdvanced += SIM_DT; n++; }
      if (n >= 720) acc = 0;
    }
  }
  if (game) {
    const total = game.teams[0].score + game.teams[1].score;
    if (total !== lastScore) {
      // swish the net at the basket nearest the ball
      arena.swish(game.ball.x > 0 ? 1 : -1);
      lastScore = total;
    }
    const animDt = Math.min(simAdvanced, 0.25);
    for (const v of views) v.update(realDt, game, animDt);
    ballView.update(simAdvanced, game);
    arena.update(realDt, game);
    director.update(realDt, game);
    hud.update(realDt);
  }
  renderer.render(scene, camera);
}

// ------------------------------------------------------------ boot
(async function boot() {
  asset = await loadPlayerAsset((f) => { $('loading-text').textContent = `Loading players… ${Math.round(f * 100)}%`; });
  $('loading').classList.add('hidden');
  openSetup();
  requestAnimationFrame(frame);
})();
