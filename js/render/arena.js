// Court, hoops, stands and the center-hung scoreboard.
import * as THREE from 'three';
import {
  HALF_L, HALF_W, RIM_X, RIM_Y, RIM_R, BOARD_FROM_RIM, BOARD_HALF_W, BOARD_BOTTOM, BOARD_TOP,
  THREE_R, CORNER3_Z, CORNER3_U, LANE_HALF_W, FT_U, RIM_FROM_BASE,
} from '../sim/constants.js';

const APRON = 2.6;

function courtTexture(homeTeam, awayTeam) {
  const W = HALF_L * 2 + APRON * 2, H = HALF_W * 2 + APRON * 2;
  const s = 64;
  const c = document.createElement('canvas');
  c.width = Math.round(W * s); c.height = Math.round(H * s);
  const g = c.getContext('2d');
  const X = (x) => (x + W / 2) * s;
  const Y = (z) => (z + H / 2) * s;

  // apron
  g.fillStyle = '#5a3a22';
  g.fillRect(0, 0, c.width, c.height);
  // hardwood planks
  const plankW = 0.12 * s;
  for (let py = 0; py < c.height; py += plankW) {
    const row = Math.round(py / plankW);
    let px = -((row * 97) % 300);
    while (px < c.width) {
      // Keep both terms non-negative: px starts negative, and a negative
      // plank length would loop forever.
      const len = 120 + ((((row * 31 + Math.floor(px)) % 180) + 180) % 180);
      const shade = 168 + ((((row * 13 + Math.floor(px)) % 22) + 22) % 22);
      g.fillStyle = `rgb(${shade + 40},${shade - 10},${shade - 70})`;
      g.fillRect(px, py, len - 1, plankW - 1);
      px += len;
    }
  }
  // darker apron over the planks
  g.fillStyle = 'rgba(60,30,10,0.55)';
  g.fillRect(0, 0, c.width, Y(-HALF_W));
  g.fillRect(0, Y(HALF_W), c.width, c.height - Y(HALF_W));
  g.fillRect(0, 0, X(-HALF_L), c.height);
  g.fillRect(X(HALF_L), 0, c.width - X(HALF_L), c.height);

  // painted lanes in team colors
  const paint = (side, color) => {
    g.fillStyle = color;
    g.globalAlpha = 0.72;
    const x0 = X(side * HALF_L), x1 = X(side * (HALF_L - FT_U));
    g.fillRect(Math.min(x0, x1), Y(-LANE_HALF_W), Math.abs(x1 - x0), Y(LANE_HALF_W) - Y(-LANE_HALF_W));
    g.globalAlpha = 1;
  };
  paint(-1, homeTeam.primary);
  paint(1, awayTeam.primary);

  g.strokeStyle = '#ffffff';
  g.lineWidth = 0.05 * s;
  g.strokeRect(X(-HALF_L), Y(-HALF_W), HALF_L * 2 * s, HALF_W * 2 * s);
  g.beginPath(); g.moveTo(X(0), Y(-HALF_W)); g.lineTo(X(0), Y(HALF_W)); g.stroke();
  g.beginPath(); g.arc(X(0), Y(0), 1.83 * s, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.arc(X(0), Y(0), 0.61 * s, 0, Math.PI * 2); g.stroke();

  for (const side of [-1, 1]) {
    const rx = side * RIM_X;
    // three-point line
    g.beginPath();
    const cornerX = side * (HALF_L - CORNER3_U);
    g.moveTo(X(side * HALF_L), Y(-CORNER3_Z));
    g.lineTo(X(cornerX), Y(-CORNER3_Z));
    const a0 = Math.asin(CORNER3_Z / THREE_R);
    if (side > 0) g.arc(X(rx), Y(0), THREE_R * s, Math.PI + a0, Math.PI - a0, true);
    else g.arc(X(rx), Y(0), THREE_R * s, -a0, a0, false);
    g.lineTo(X(side * HALF_L), Y(CORNER3_Z));
    g.stroke();
    // lane
    const ftx = side * (HALF_L - FT_U);
    g.strokeRect(Math.min(X(side * HALF_L), X(ftx)), Y(-LANE_HALF_W), Math.abs(X(ftx) - X(side * HALF_L)), LANE_HALF_W * 2 * s);
    // free-throw circle
    g.beginPath();
    g.arc(X(ftx), Y(0), 1.83 * s, side > 0 ? Math.PI / 2 : -Math.PI / 2, side > 0 ? Math.PI * 1.5 : Math.PI / 2);
    g.stroke();
    g.setLineDash([0.3 * s, 0.3 * s]);
    g.beginPath();
    g.arc(X(ftx), Y(0), 1.83 * s, side > 0 ? -Math.PI / 2 : Math.PI / 2, side > 0 ? Math.PI / 2 : Math.PI * 1.5);
    g.stroke();
    g.setLineDash([]);
    // restricted area
    g.beginPath();
    g.arc(X(rx), Y(0), 1.22 * s, side > 0 ? Math.PI / 2 : -Math.PI / 2, side > 0 ? Math.PI * 1.5 : Math.PI / 2);
    g.stroke();
    // lane hash marks
    for (const u of [2.13, 3.0, 3.87, 4.75]) {
      const hx = X(side * (HALF_L - u));
      for (const zz of [-1, 1]) {
        g.beginPath();
        g.moveTo(hx, Y(zz * LANE_HALF_W));
        g.lineTo(hx, Y(zz * (LANE_HALF_W + 0.2)));
        g.stroke();
      }
    }
  }

  // center logo
  g.save();
  g.translate(X(0), Y(0));
  g.fillStyle = homeTeam.primary;
  g.beginPath(); g.arc(0, 0, 1.75 * s, 0, Math.PI * 2); g.fill();
  g.fillStyle = homeTeam.secondary;
  g.font = `bold ${0.95 * s}px "Segoe UI", Arial, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(homeTeam.abbr, 0, 0);
  g.restore();

  // baseline names
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.font = `bold ${0.9 * s}px "Segoe UI", Arial, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const [side, name] of [[-1, homeTeam.name], [1, homeTeam.name]]) {
    g.save();
    g.translate(X(side * (HALF_L + 1.3)), Y(0));
    g.rotate(side * Math.PI / 2);
    g.fillText(name.toUpperCase(), 0, 0);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { tex, W, H };
}

function makeHoop(side) {
  const grp = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
  const orange = new THREE.MeshStandardMaterial({ color: 0xff5a14, roughness: 0.35, metalness: 0.5 });
  const padMat = new THREE.MeshStandardMaterial({ color: 0x1a2340, roughness: 0.7 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.3, metalness: 0.8 });
  const rx = side * RIM_X;
  const bx = side * (RIM_X + BOARD_FROM_RIM);

  // Stanchion base behind the baseline.
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.1, 1.6), padMat);
  base.position.set(side * (HALF_L + 2.3), 0.55, 0);
  base.castShadow = true;
  grp.add(base);
  const pole = new THREE.Mesh(new THREE.BoxGeometry(0.35, 3.3, 0.35), padMat);
  pole.position.set(side * (HALF_L + 1.9), 2.2, 0);
  pole.castShadow = true;
  grp.add(pole);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(side * (HALF_L + 1.9) - bx), 0.18, 0.18), steel);
  arm.position.set((side * (HALF_L + 1.9) + bx) / 2 + side * 0.05, 3.6, 0);
  grp.add(arm);

  // Glass backboard with white border and shooter's square.
  const bh = BOARD_TOP - BOARD_BOTTOM;
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(0.03, bh, BOARD_HALF_W * 2),
    new THREE.MeshPhysicalMaterial({ color: 0xcfe8ff, transparent: true, opacity: 0.25, roughness: 0.05, metalness: 0 }),
  );
  glass.position.set(bx + side * 0.015, (BOARD_TOP + BOARD_BOTTOM) / 2, 0);
  grp.add(glass);
  const frame = (w, h, y, t) => {
    const m = new THREE.Group();
    const parts = [
      [0.035, t, w, y + h / 2 - t / 2, 0], [0.035, t, w, y - h / 2 + t / 2, 0],
      [0.035, h, t, y, w / 2 - t / 2], [0.035, h, t, y, -w / 2 + t / 2],
    ];
    for (const [a, b, c, py, pz] of parts) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(a, b, c), white);
      bar.position.set(bx + side * 0.012, py, pz);
      m.add(bar);
    }
    return m;
  };
  grp.add(frame(BOARD_HALF_W * 2, bh, (BOARD_TOP + BOARD_BOTTOM) / 2, 0.05));
  grp.add(frame(0.61, 0.46, RIM_Y + 0.15 + 0.23, 0.05));
  const pad = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, BOARD_HALF_W * 2), padMat);
  pad.position.set(bx + side * 0.03, BOARD_BOTTOM - 0.02, 0);
  grp.add(pad);

  // Rim + connector.
  const rim = new THREE.Mesh(new THREE.TorusGeometry(RIM_R, 0.011, 8, 40), orange);
  rim.rotation.x = Math.PI / 2;
  rim.position.set(rx, RIM_Y, 0);
  rim.castShadow = true;
  grp.add(rim);
  const conn = new THREE.Mesh(new THREE.BoxGeometry(BOARD_FROM_RIM - RIM_R, 0.03, 0.12), orange);
  conn.position.set(rx + side * (RIM_R + (BOARD_FROM_RIM - RIM_R) / 2), RIM_Y - 0.01, 0);
  grp.add(conn);

  // Net: open cone drawn as a wireframe mesh.
  const netGeo = new THREE.CylinderGeometry(RIM_R, RIM_R * 0.55, 0.42, 14, 4, true);
  const net = new THREE.Mesh(netGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.85 }));
  const netPivot = new THREE.Group();
  netPivot.position.set(rx, RIM_Y, 0);
  net.position.y = -0.21;
  netPivot.add(net);
  grp.add(netPivot);
  return { grp, netPivot, rimX: rx };
}

function makeCrowd() {
  const grp = new THREE.Group();
  const standMat = new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.9 });
  const rows = 9, step = 0.85, rise = 0.45;
  const inner = { x: HALF_L + APRON + 1.2, z: HALF_W + APRON + 1.2 };
  // stepped stands on 4 sides
  for (let r = 0; r < rows; r++) {
    const h = (r + 1) * rise;
    const ox = inner.x + r * step, oz = inner.z + r * step;
    const long = new THREE.BoxGeometry(ox * 2 + step * 2, h, step);
    const short = new THREE.BoxGeometry(step, h, oz * 2);
    for (const s of [-1, 1]) {
      const m1 = new THREE.Mesh(long, standMat);
      m1.position.set(0, h / 2, s * (oz + step / 2));
      m1.receiveShadow = true;
      grp.add(m1);
      const m2 = new THREE.Mesh(short, standMat);
      m2.position.set(s * (ox + step / 2), h / 2, 0);
      m2.receiveShadow = true;
      grp.add(m2);
    }
  }
  // fans: instanced capsules
  const fanGeo = new THREE.CapsuleGeometry(0.2, 0.45, 3, 6);
  const fanMat = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  const spots = [];
  for (let r = 0; r < rows; r++) {
    const ox = inner.x + r * step + step / 2, oz = inner.z + r * step + step / 2;
    const y = (r + 1) * rise + 0.45;
    for (let x = -ox + 0.5; x < ox - 0.3; x += 0.62) {
      spots.push([x, y, oz], [x, y, -oz]);
    }
    for (let z = -oz + 0.9; z < oz - 0.6; z += 0.62) {
      spots.push([ox, y, z], [-ox, y, z]);
    }
  }
  const mesh = new THREE.InstancedMesh(fanGeo, fanMat, spots.length);
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  const palette = [0xd9d9d9, 0x2f3b52, 0xb33a3a, 0x3a6fb3, 0xe0b44a, 0x444444, 0x7a4fa0, 0x2e8b57, 0xf2f2f2, 0x1b1b1b];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  spots.forEach((p, i) => {
    if (rnd() < 0.12) { m.makeScale(0, 0, 0); } // empty seat
    else m.makeTranslation(p[0] + (rnd() - 0.5) * 0.1, p[1], p[2]);
    mesh.setMatrixAt(i, m);
    col.setHex(palette[Math.floor(rnd() * palette.length)]);
    mesh.setColorAt(i, col);
  });
  grp.add(mesh);
  return { grp, crowd: mesh, spots };
}

function makeTableAndBenches(home, away) {
  const grp = new THREE.Group();
  const table = new THREE.Mesh(new THREE.BoxGeometry(7, 0.8, 0.8), new THREE.MeshStandardMaterial({ color: 0x111318 }));
  table.position.set(0, 0.4, HALF_W + 1.25);
  grp.add(table);
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(6.8, 0.5), new THREE.MeshBasicMaterial({ color: 0x1f6feb }));
  strip.position.set(0, 0.45, HALF_W + 0.84);
  strip.rotation.y = Math.PI;
  grp.add(strip);
  for (const [sign, team] of [[-1, home], [1, away]]) {
    const bench = new THREE.Mesh(new THREE.BoxGeometry(8, 0.45, 0.6), new THREE.MeshStandardMaterial({ color: new THREE.Color(team.primary).multiplyScalar(0.6) }));
    bench.position.set(sign * 6.4, 0.22, HALF_W + 2.55);
    bench.castShadow = true;
    grp.add(bench);
  }
  return grp;
}

function makeScoreboard() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const face = new THREE.MeshBasicMaterial({ map: tex });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0b0c10 });
  const box = new THREE.Mesh(new THREE.BoxGeometry(4.2, 2.1, 4.2), [face, face, dark, dark, face, face]);
  box.position.set(0, 13, 0);
  const draw = (game) => {
    const g = c.getContext('2d');
    const [a, b] = game.teams;
    g.fillStyle = '#05060a'; g.fillRect(0, 0, 512, 256);
    g.fillStyle = a.primary; g.fillRect(0, 0, 256, 40);
    g.fillStyle = b.primary; g.fillRect(256, 0, 256, 40);
    g.fillStyle = '#fff'; g.font = 'bold 30px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(a.abbr, 128, 21); g.fillText(b.abbr, 384, 21);
    g.fillStyle = '#ffcf33'; g.font = 'bold 110px "Courier New", monospace';
    g.fillText(String(a.score), 128, 120); g.fillText(String(b.score), 384, 120);
    g.fillStyle = '#ff4136'; g.font = 'bold 44px "Courier New", monospace';
    const clk = game.clock >= 60 ? `${Math.floor(game.clock / 60)}:${String(Math.floor(game.clock % 60)).padStart(2, '0')}` : game.clock.toFixed(1);
    g.fillText(`${game.periodName()}  ${clk}`, 256, 215);
    tex.needsUpdate = true;
  };
  return { mesh: box, draw };
}

export class Arena {
  constructor(scene, home, away) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);

    const { tex, W, H } = courtTexture(home, away);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.42, metalness: 0.05 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.group.add(floor);
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(140, 100), new THREE.MeshStandardMaterial({ color: 0x121419, roughness: 1 }));
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.01;
    this.group.add(outer);

    this.hoops = [makeHoop(-1), makeHoop(1)];
    for (const h of this.hoops) this.group.add(h.grp);
    this.netAnim = [0, 0];

    const crowd = makeCrowd();
    this.group.add(crowd.grp);
    this.crowd = crowd;
    this.group.add(makeTableAndBenches(home, away));
    this.board = makeScoreboard();
    this.group.add(this.board.mesh);
    this.lastBoardKey = '';
  }

  swish(side) {
    this.netAnim[side > 0 ? 1 : 0] = 1;
  }

  update(dt, game) {
    for (let i = 0; i < 2; i++) {
      const a = this.netAnim[i];
      const net = this.hoops[i].netPivot;
      if (a > 0) {
        this.netAnim[i] = Math.max(0, a - dt * 2.2);
        const k = Math.sin((1 - this.netAnim[i]) * Math.PI);
        net.scale.set(1 - 0.12 * k, 1 + 0.35 * k, 1 - 0.12 * k);
      } else net.scale.set(1, 1, 1);
    }
    const key = `${game.teams[0].score}-${game.teams[1].score}-${game.period}-${Math.ceil(game.clock * (game.clock < 60 ? 10 : 1))}`;
    if (key !== this.lastBoardKey) {
      this.lastBoardKey = key;
      this.board.draw(game);
    }
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
    });
  }
}

export { RIM_FROM_BASE };
