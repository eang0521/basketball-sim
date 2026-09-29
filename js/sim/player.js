import { G, HALF_L, HALF_W, POS_ORDER } from './constants.js';
import { clamp } from '../util.js';
import { overall } from '../data/teams.js';

export function newStats() {
  return {
    min: 0, pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0,
    oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0, pm: 0,
  };
}

export class Player {
  constructor(data, teamIdx, rosterIdx) {
    this.id = `${teamIdx}-${rosterIdx}`;
    this.rosterIdx = rosterIdx;
    this.name = data.name;
    this.num = data.num;
    this.pos = data.pos;
    this.posIdx = POS_ORDER.indexOf(data.pos);
    this.heightCm = data.height;
    this.r = { ...data.ratings };
    this.ovr = overall(this);
    this.team = teamIdx;

    this.x = 0; this.z = 0; this.y = 0;
    this.vx = 0; this.vz = 0; this.vy = 0;
    this.facing = 0;
    this.tx = 0; this.tz = 0; // movement target
    this.speedMul = 1; // fraction of max speed allowed
    this.face = null; // {x,z} point to face, or null to face velocity
    this.stamina = 1;
    this.fouls = 0;
    this.fouledOut = false;
    this.onCourt = false;
    this.action = null; // current timed action (shoot, pass, ...)
    this.intent = 'Waiting';
    this.stats = newStats();

    // AI bookkeeping
    this.man = null; // defensive assignment
    this.spot = null; // offensive spacing spot {u,v}
    this.plan = null;
    this.decisionT = 0;
    this.moveT = 0;
    this.catchT = -99;
    this.passer = null;
    this.stunT = 0; // defender beaten by a move: reaction frozen
    this.lagX = 0; this.lagZ = 0;
    this.pose = 'none'; // hint for the renderer
    this.benchX = 0; this.benchZ = 0;
    this.lastFoulCheck = 0;
  }

  get h() { return this.heightCm / 100; }
  get standReach() { return this.h * 1.33; }
  get reach() { return this.standReach + this.y; }
  get airborne() { return this.y > 0 || this.vy > 0; }
  get speed() { return Math.hypot(this.vx, this.vz); }

  maxSpeed() {
    return (5.4 + (this.r.spd / 99) * 3.2) * (0.8 + 0.2 * this.stamina);
  }
  accel() {
    return (5 + (this.r.acc / 99) * 8) * (0.82 + 0.18 * this.stamina);
  }
  jumpHeight() {
    return (0.4 + (this.r.vert / 99) * 0.55) * (0.85 + 0.15 * this.stamina);
  }
  startJump(frac = 1) {
    if (this.airborne) return false;
    this.vy = Math.sqrt(2 * G * this.jumpHeight() * frac);
    return true;
  }
  setTarget(x, z, speedMul = 1) {
    this.tx = x; this.tz = z; this.speedMul = speedMul;
  }
}

// Integrates one player's motion toward their target with speed/accel limits.
export function movePlayer(p, dt, hasBall) {
  if (p.y > 0 || p.vy > 0) {
    p.vy -= G * dt;
    p.y += p.vy * dt;
  }
  if (p.y <= 0) { p.y = 0; p.vy = 0; }
  const grounded = p.y === 0;
  if (grounded) {
    const dx = p.tx - p.x, dz = p.tz - p.z;
    const d = Math.hypot(dx, dz);
    let maxS = p.maxSpeed() * p.speedMul;
    if (hasBall) maxS *= 0.84 + 0.12 * (p.r.handle / 99);
    if (p.stunT > 0) maxS *= 0.35;
    const want = d < 0.04 ? 0 : Math.min(maxS, d * 3.2);
    const wx = d > 1e-6 ? (dx / d) * want : 0;
    const wz = d > 1e-6 ? (dz / d) * want : 0;
    let ax = wx - p.vx, az = wz - p.vz;
    const al = Math.hypot(ax, az);
    // decelerating is easier than accelerating
    const decel = wx * p.vx + wz * p.vz < 0 || want < p.speed;
    const lim = p.accel() * (decel ? 1.6 : 1) * dt;
    if (al > lim) { ax = (ax / al) * lim; az = (az / al) * lim; }
    p.vx += ax; p.vz += az;
  }
  p.x += p.vx * dt;
  p.z += p.vz * dt;
  if (p.onCourt) {
    p.x = clamp(p.x, -HALF_L - 1.2, HALF_L + 1.2);
    p.z = clamp(p.z, -HALF_W - 1.2, HALF_W + 1.2);
  }
  // facing
  let fx, fz;
  if (p.face) { fx = p.face.x - p.x; fz = p.face.z - p.z; }
  else if (p.speed > 0.6) { fx = p.vx; fz = p.vz; }
  if (fx !== undefined && (fx * fx + fz * fz) > 1e-4) {
    const target = Math.atan2(fx, fz);
    const TAU = 2 * Math.PI;
    const diff = ((((target - p.facing + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
    const turn = 9 * dt;
    p.facing += clamp(diff, -turn, turn);
  }
  if (p.stunT > 0) p.stunT -= dt;
}
