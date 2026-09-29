// Converts ratings + situation into make probabilities. The probability decides
// where the shooter aims (clean through the hoop vs. off the rim); the physics
// engine then decides what actually happens.
import { rimForDir } from './physics.js';
import { isThree, RIM_Y } from './constants.js';
import { clamp } from '../util.js';

export function canDunk(p) {
  return p.standReach + p.jumpHeight() >= RIM_Y + 0.28;
}

// How well the nearest defender contests a shot at (x,z). 0 = wide open, ~1 = smothered.
export function contestAt(g, shooter, x, z, lookahead = 0) {
  const opp = g.teams[1 - shooter.team].onCourt;
  const rim = rimForDir(g.teams[shooter.team].dir);
  const dRim = Math.hypot(x - rim.x, z - rim.z);
  let best = null, bd = 99;
  for (const d of opp) {
    let dd = Math.hypot(d.x - x, d.z - z);
    if (lookahead > 0) dd = Math.max(0.4, dd - lookahead * d.maxSpeed() * 0.55);
    // Defenders behind the shooter (farther from the rim) contest less well.
    const behind = Math.hypot(d.x - rim.x, d.z - rim.z) > dRim + 0.4;
    if (behind) dd += 0.6;
    if (dd < bd) { bd = dd; best = d; }
  }
  if (!best) return { level: 0, def: null, d: 99 };
  const skill = dRim < 3.2 ? best.r.intD * 0.55 + best.r.blk * 0.45 : best.r.perD;
  const hAdv = (best.heightCm - shooter.heightCm) / 100;
  let level = clamp((1.95 - bd) / 1.5, 0, 1);
  level *= 0.62 + (0.38 * skill) / 99 + clamp(hAdv * 0.9, -0.2, 0.3);
  return { level: clamp(level, 0, 1.25), def: best, d: bd };
}

export function shotInfo(g, p, x, z, opts = {}) {
  const team = g.teams[p.team];
  const rim = rimForDir(team.dir);
  const d = Math.hypot(x - rim.x, z - rim.z);
  const three = isThree(team.dir, x, z);
  const r = p.r;
  let prob, type;
  if (d < 1.75) {
    type = canDunk(p) && d < 1.5 && opts.moving ? 'dunk' : 'layup';
    prob = type === 'dunk' ? 0.9 + (r.inside - 70) * 0.002 : 0.6 + (r.inside - 70) * 0.008;
  } else if (d < 3.7) {
    type = 'floater';
    prob = 0.44 + (r.inside * 0.55 + r.mid * 0.45 - 70) * 0.0065 - (d - 1.75) * 0.02;
  } else if (!three) {
    type = 'jumper';
    prob = 0.44 + (r.mid - 70) * 0.0065 - (d - 3.7) * 0.009;
  } else {
    type = 'three';
    prob = 0.415 + (r.three - 70) * 0.005 - Math.max(0, d - 7.4) * 0.05;
  }
  if (d > 9.5) prob *= Math.max(0.04, 1 - (d - 9.5) * 0.2);

  const c = opts.contest ?? contestAt(g, p, x, z, opts.lookahead || 0);
  const lvl = c.level;
  if (type === 'dunk') {
    if (lvl > 0.85) { type = 'layup'; prob = 0.62 + (r.inside - 70) * 0.008; prob *= 1 - 0.33 * lvl; }
    else prob *= 1 - 0.12 * lvl;
  } else if (type === 'layup') prob *= 1 - 0.4 * lvl;
  else if (type === 'floater') prob *= 1 - 0.36 * lvl;
  else prob *= 1 - 0.2 * lvl - (lvl > 0.8 ? (lvl - 0.8) * 0.4 : 0);

  if ((type === 'jumper' || type === 'three')) {
    if (opts.catchShoot) prob += 0.015;
    else if (opts.offDribble) prob -= 0.025;
  }
  prob *= 0.85 + 0.15 * p.stamina;
  prob = clamp(prob, 0.01, 0.97);
  const pts = three ? 3 : 2;
  return { p: prob, pts, type, d, three, contest: lvl, def: c.def, ev: prob * pts };
}

export function ftProb(p) {
  return clamp(0.3 + p.r.ft * 0.0066, 0.3, 0.96) * (0.95 + 0.05 * p.stamina);
}

// Returns the blocking defender or null.
export function rollBlock(g, shooter, info) {
  const opp = g.teams[1 - shooter.team].onCourt;
  const base = info.type === 'layup' ? 0.1 : info.type === 'dunk' ? 0.05 : info.type === 'floater' ? 0.075 : info.type === 'jumper' ? 0.022 : 0.012;
  for (const d of opp) {
    const dd = Math.hypot(d.x - shooter.x, d.z - shooter.z);
    if (dd > 1.7) continue;
    const reachAdv = (d.standReach + d.jumpHeight()) - (shooter.standReach + shooter.jumpHeight() * 0.7);
    let pr = base * Math.pow(d.r.blk / 70, 1.7) * clamp((1.7 - dd) / 1.0, 0, 1) * clamp(1 + reachAdv * 1.3, 0.3, 2.2);
    if (d.stunT > 0) pr *= 0.4;
    if (g.rng() < pr) return d;
  }
  return null;
}

// Returns the fouling defender or null.
export function rollShootingFoul(g, shooter, info) {
  const def = info.def;
  if (!def) return null;
  const dd = Math.hypot(def.x - shooter.x, def.z - shooter.z);
  if (dd > 2.0) return null;
  const base = info.type === 'layup' || info.type === 'dunk' ? 0.34 : info.type === 'floater' ? 0.26 : info.type === 'jumper' ? 0.07 : 0.028;
  const discipline = 1.35 - (def.r.awr / 99) * 0.7;
  const draw = 0.7 + ((shooter.r.str + shooter.r.inside) / 2 / 99) * 0.6;
  const pr = base * (0.3 + 0.7 * info.contest) * discipline * draw;
  return g.rng() < pr ? def : null;
}
