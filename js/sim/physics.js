// Ball physics: projectile motion with collisions against the rims (torus),
// backboards (planes) and the floor. Scoring is detected geometrically, so a
// shot only counts if the ball actually drops through the hoop.
import {
  G, BALL_R, RIM_Y, RIM_R, RIM_TUBE, RIM_X, BOARD_FROM_RIM, BOARD_HALF_W,
  BOARD_BOTTOM, BOARD_TOP, HALF_L, HALF_W,
} from './constants.js';

export class Ball {
  constructor() {
    this.x = 0; this.y = 1; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.state = 'dead'; // 'held' | 'air' | 'dead'
    this.holder = null;
    this.shot = null; // active shot info while a shot is unresolved
    this.pass = null; // active pass info while a pass is in flight
    this.lastTouch = null;
    this.deflectedBy = null;
    this.lostBy = null;
    this.spin = 0;
    this.nearRimT = 0;
  }
  get speed() { return Math.hypot(this.vx, this.vy, this.vz); }
}

export const RIMS = [
  { side: 1, x: RIM_X, y: RIM_Y, z: 0, boardX: RIM_X + BOARD_FROM_RIM },
  { side: -1, x: -RIM_X, y: RIM_Y, z: 0, boardX: -RIM_X - BOARD_FROM_RIM },
];

export function rimForDir(dir) {
  return dir > 0 ? RIMS[0] : RIMS[1];
}

const SUBSTEPS = 5;

// Advances the loose ball and pushes physics events into `ev`.
export function stepBall(ball, dt, ev, rng) {
  const h = dt / SUBSTEPS;
  for (let i = 0; i < SUBSTEPS; i++) {
    const py = ball.y;
    ball.vy -= G * h;
    ball.x += ball.vx * h;
    ball.y += ball.vy * h;
    ball.z += ball.vz * h;

    for (const rim of RIMS) {
      if (Math.abs(ball.x - rim.x) > 1.4 || ball.y < 2.3 || ball.y > 4.3) continue;
      collideBoard(ball, rim, ev);
      collideRim(ball, rim, ev, rng);
      // Scoring: ball center passes downward through the rim plane inside the ring.
      if (py > rim.y && ball.y <= rim.y && ball.vy < 0) {
        const hd = Math.hypot(ball.x - rim.x, ball.z - rim.z);
        if (hd < RIM_R - 0.02) ev.push({ type: 'score', rim });
      }
      // Net drag on the way through
      const hd2 = Math.hypot(ball.x - rim.x, ball.z - rim.z);
      if (ball.y < rim.y && ball.y > rim.y - 0.45 && hd2 < RIM_R) {
        const k = 1 - 7 * h;
        ball.vx *= k; ball.vz *= k;
        if (ball.vy < -3.5) ball.vy *= 1 - 3 * h;
      }
    }

    if (ball.y < BALL_R) {
      ball.y = BALL_R;
      if (ball.vy < 0) {
        const impact = -ball.vy;
        ball.vy = impact > 0.5 ? impact * 0.76 : 0;
        ball.vx *= 0.9; ball.vz *= 0.9;
        if (impact > 0.5) ev.push({ type: 'floor', x: ball.x, z: ball.z, impact });
        else ev.push({ type: 'floorRest', x: ball.x, z: ball.z });
      }
      // rolling friction
      if (ball.vy === 0) {
        const k = 1 - 1.1 * h;
        ball.vx *= k; ball.vz *= k;
      }
    }
  }
  // Out of bounds: ball touching the floor outside the lines, or flying into the stands.
  if ((ball.y <= BALL_R + 0.02 && (Math.abs(ball.x) > HALF_L || Math.abs(ball.z) > HALF_W)) ||
      Math.abs(ball.x) > HALF_L + 2.5 || Math.abs(ball.z) > HALF_W + 2.5) {
    ev.push({ type: 'oob', x: ball.x, z: ball.z });
  }
  // Safety: a ball sitting on the rim too long gets nudged off.
  let near = false;
  for (const rim of RIMS) {
    if (Math.abs(ball.x - rim.x) < 0.5 && Math.abs(ball.y - rim.y) < 0.25 && Math.abs(ball.z) < 0.5) near = true;
  }
  ball.nearRimT = near ? ball.nearRimT + dt : 0;
  if (ball.nearRimT > 1.2) {
    ball.vx += (rng() - 0.5) * 2; ball.vz += (rng() - 0.5) * 2; ball.vy += 0.5;
    ball.nearRimT = 0;
  }
}

function collideRim(ball, rim, ev, rng) {
  const dx = ball.x - rim.x, dz = ball.z - rim.z;
  const L = Math.hypot(dx, dz) || 1e-6;
  const qx = rim.x + (dx / L) * RIM_R, qz = rim.z + (dz / L) * RIM_R, qy = rim.y;
  const nx = ball.x - qx, ny = ball.y - qy, nz = ball.z - qz;
  const d = Math.hypot(nx, ny, nz);
  const minD = BALL_R + RIM_TUBE;
  if (d < minD && d > 1e-6) {
    const ux = nx / d, uy = ny / d, uz = nz / d;
    ball.x = qx + ux * minD; ball.y = qy + uy * minD; ball.z = qz + uz * minD;
    const vn = ball.vx * ux + ball.vy * uy + ball.vz * uz;
    if (vn < 0) {
      const e = 0.5 + rng() * 0.15;
      ball.vx -= (1 + e) * vn * ux;
      ball.vy -= (1 + e) * vn * uy;
      ball.vz -= (1 + e) * vn * uz;
      // tangential friction plus a touch of randomness (rim isn't perfectly rigid)
      ball.vx *= 0.9; ball.vz *= 0.9;
      ball.vx += (rng() - 0.5) * 0.25;
      ball.vz += (rng() - 0.5) * 0.25;
      ev.push({ type: 'rim', rim, impact: -vn });
    }
  }
}

function collideBoard(ball, rim, ev) {
  const s = rim.side;
  const d = (rim.boardX - ball.x) * s; // distance in front of the board face
  if (d < BALL_R && d > -0.08 && ball.vx * s > 0 &&
      ball.y > BOARD_BOTTOM - BALL_R && ball.y < BOARD_TOP + BALL_R && Math.abs(ball.z) < BOARD_HALF_W + BALL_R) {
    ball.x = rim.boardX - s * BALL_R;
    ball.vx = -ball.vx * 0.55;
    ball.vy *= 0.85; ball.vz *= 0.85;
    ev.push({ type: 'board', rim });
  }
}

// Initial velocity to travel from `from` to `to` launched at `angle` radians.
export function solveLaunch(from, to, angle) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const D = Math.max(0.05, Math.hypot(dx, dz));
  const H = to.y - from.y;
  let th = angle;
  let denom = 2 * Math.cos(th) ** 2 * (D * Math.tan(th) - H);
  while (denom <= 0.01 && th < 1.5) {
    th += 0.05;
    denom = 2 * Math.cos(th) ** 2 * (D * Math.tan(th) - H);
  }
  const v = Math.sqrt((G * D * D) / denom);
  const vh = v * Math.cos(th);
  return { vx: (dx / D) * vh, vy: v * Math.sin(th), vz: (dz / D) * vh, t: D / vh };
}

// Velocity to reach `to` from `from` in exactly `t` seconds.
export function solveTimed(from, to, t) {
  return {
    vx: (to.x - from.x) / t,
    vy: (to.y - from.y + 0.5 * G * t * t) / t,
    vz: (to.z - from.z) / t,
  };
}

// Where will the ball be when it drops to height `y` (ignoring collisions)?
export function predictLanding(ball, y) {
  const a = -0.5 * G, b = ball.vy, c = ball.y - y;
  const disc = b * b - 4 * a * c;
  let t;
  if (disc < 0) t = 0;
  else t = Math.max(0, (-b - Math.sqrt(disc)) / (2 * a));
  return { x: ball.x + ball.vx * t, z: ball.z + ball.vz * t, t };
}
