// Player decision making. Every choice is an expected-points comparison
// (shoot vs. drive vs. pass vs. keep probing), blurred by the player's awareness.
import { rimForDir, predictLanding } from './physics.js';
import { HALF_L, HALF_W, uOf, toCourt, RIM_Y, POS_ORDER } from './constants.js';
import { clamp, lerp, gauss, sigmoid, distToSegment } from '../util.js';
import { shotInfo, canDunk } from './shotmodel.js';

export const SPOTS = {
  top: [9.3, 0], slotL: [8.7, 3.4], slotR: [8.7, -3.4], wingL: [6.7, 5.8], wingR: [6.7, -5.8],
  cornerL: [0.95, 6.9], cornerR: [0.95, -6.9], elbowL: [5.8, 2.5], elbowR: [5.8, -2.5],
  blockL: [2.1, 2.35], blockR: [2.1, -2.35], dunkerL: [0.95, 3.2], dunkerR: [0.95, -3.2],
};

const GUARD_PREF = ['wingL', 'wingR', 'slotL', 'slotR', 'top', 'cornerL', 'cornerR'];
const WING_PREF = ['cornerL', 'cornerR', 'wingL', 'wingR', 'slotL', 'slotR'];
const BIG_SHOOTER_PREF = ['cornerL', 'cornerR', 'wingL', 'wingR', 'elbowL', 'elbowR'];
const BIG_PREF = ['blockL', 'blockR', 'dunkerL', 'dunkerR', 'elbowL', 'elbowR'];

function spotPos(team, key) {
  const s = SPOTS[key];
  return toCourt(team.dir, s[0], s[1]);
}

export function defenderOf(g, p) {
  for (const d of g.teams[1 - p.team].onCourt) if (d.man === p) return d;
  return null;
}

function unitTo(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const d = Math.hypot(dx, dz) || 1e-6;
  return { x: dx / d, z: dz / d, d };
}

function clampCourt(p, m = 0.3) {
  p.tx = clamp(p.tx, -HALF_L + m, HALF_L - m);
  p.tz = clamp(p.tz, -HALF_W + m, HALF_W - m);
}

// Expected value of simply keeping the ball and working for a better look.
function holdValue(g, team) {
  let t = Math.min(g.shotClock, g.clock);
  // Late in a period with the shot clock off: hold for the last shot.
  if (g.clock < g.shotClock && g.clock > 7) return 1.3;
  // Early in a half-court set the offense is patient and runs its action.
  const setBonus = team.mode === 'half' ? 0.22 * clamp(1 - team.modeT / 9, 0, 1) : 0.12;
  return 1.2 * Math.pow(Math.max(0, t) / 24, 0.3) + setBonus;
}

export function inFrontcourt(team, p) {
  return uOf(team.dir, p.x) < HALF_L - 0.2;
}

// ---------------------------------------------------------------- offense

export function assignSpots(g, team) {
  const h = g.ball.holder;
  const taken = new Set();
  if (h && h.team === team.idx) {
    for (const k in SPOTS) {
      const sp = spotPos(team, k);
      if (Math.hypot(sp.x - h.x, sp.z - h.z) < 3.2) taken.add(k);
    }
  }
  const order = [...team.onCourt].filter((p) => p !== h).sort((a, b) => b.posIdx - a.posIdx);
  for (const p of order) {
    let prefs;
    if (p.posIdx >= 3) prefs = p.r.three >= 64 ? BIG_SHOOTER_PREF : BIG_PREF;
    else if (p.posIdx === 2) prefs = WING_PREF;
    else prefs = GUARD_PREF;
    let best = null, bs = 1e9;
    prefs.forEach((k, i) => {
      if (taken.has(k)) return;
      const sp = spotPos(team, k);
      const s = i * 1.6 + Math.hypot(sp.x - p.x, sp.z - p.z) * 0.25 + g.rng() * 1.5;
      if (s < bs) { bs = s; best = k; }
    });
    if (!best) best = Object.keys(SPOTS).find((k) => !taken.has(k)) || 'top';
    taken.add(best);
    p.spot = best;
    p.plan = null;
    p.moveT = 1.5 + g.rng() * 3;
  }
}

function freeSpot(g, team, p) {
  const used = new Set(team.onCourt.filter((q) => q !== p).map((q) => q.spot));
  const h = g.ball.holder;
  const keys = Object.keys(SPOTS).filter((k) => {
    if (used.has(k)) return false;
    const sp = spotPos(team, k);
    if (h && Math.hypot(sp.x - h.x, sp.z - h.z) < 3.2) return false;
    if (p.posIdx <= 1 && k.startsWith('block')) return false;
    if (p.posIdx >= 3 && p.r.three < 60 && (k.startsWith('corner') || k.startsWith('wing') || k.startsWith('slot') || k === 'top')) return false;
    return true;
  });
  if (!keys.length) return p.spot || 'top';
  keys.sort((a, b) => {
    const pa = spotPos(team, a), pb = spotPos(team, b);
    return Math.hypot(pa.x - p.x, pa.z - p.z) - Math.hypot(pb.x - p.x, pb.z - p.z);
  });
  return keys[Math.floor(g.rng() * Math.min(3, keys.length))];
}

export function offenseThink(g, team, dt) {
  const h = g.ball.holder;
  if (!h || h.team !== team.idx) return;
  const front = inFrontcourt(team, h);
  if (!front) {
    if (team.mode !== 'transition') { team.mode = 'transition'; team.modeT = 0; }
  } else if (team.mode === 'transition') {
    team.modeT += dt;
    const rim = rimForDir(team.dir);
    const hd = Math.hypot(h.x - rim.x, h.z - rim.z);
    if (team.modeT > 2.2 || hd < 8.5) {
      team.mode = 'half';
      team.modeT = 0;
      team.playT = 2 + g.rng() * 4;
      assignSpots(g, team);
    }
  }

  handlerThink(g, h, team, dt);
  for (const p of team.onCourt) if (p !== h) offBallThink(g, p, team, dt);

  if (team.mode === 'half') {
    team.modeT += dt;
    team.playT -= dt;
    if (team.playT <= 0) {
      team.playT = 6 + g.rng() * 6;
      maybeCallPnR(g, team, h);
    }
  }
}

function maybeCallPnR(g, team, h) {
  if (h.action || (h.plan && h.plan.type === 'drive')) return;
  if (g.shotClock < 7) return;
  const rim = rimForDir(team.dir);
  if (Math.hypot(h.x - rim.x, h.z - rim.z) < 6.5) return;
  const bigs = team.onCourt.filter((p) => p !== h && p.posIdx >= 2);
  if (!bigs.length) return;
  const rate = 0.45 + (h.r.pass - 60) / 200;
  if (g.rng() > rate) return;
  const screener = bigs.sort((a, b) => b.posIdx * 10 + b.r.str - (a.posIdx * 10 + a.r.str))[0];
  screener.plan = { type: 'screen', stage: 'move', t: 0 };
  h.plan = { type: 'pnr', screener, until: g.time + 4 };
  h.intent = `Calling for a screen from #${screener.num}`;
}

function handlerThink(g, h, team, dt) {
  if (h.action) return;
  const rim = rimForDir(team.dir);
  const toRim = unitTo(h.x, h.z, rim.x, rim.z);
  h.decisionT -= dt;
  if (!h.plan || h.plan.until < g.time) h.decisionT = Math.min(h.decisionT, 0);
  if (h.decisionT <= 0) {
    decide(g, h, team);
    if (h.action) return;
  }
  const plan = h.plan;
  h.face = { x: rim.x, z: rim.z };
  h.dribbling = true;
  h.pose = 'dribble';
  switch (plan && plan.type) {
    case 'advance': {
      const pt = toCourt(team.dir, plan.fast ? 3 : 9.5, clamp(h.z * team.dir, -4, 4));
      h.setTarget(pt.x, pt.z, plan.fast ? 1 : 0.75);
      h.intent = plan.fast ? 'Pushing the pace' : 'Bringing the ball up';
      h.face = null;
      break;
    }
    case 'drive': {
      const d = defenderOf(g, h);
      const nx = -toRim.z, nz = toRim.x;
      let tx = rim.x - toRim.x * 0.55, tz = rim.z - toRim.z * 0.55;
      if (d) {
        const rx = d.x - h.x, rz = d.z - h.z;
        const along = rx * toRim.x + rz * toRim.z;
        const perp = rx * nx + rz * nz;
        if (along > -0.1 && along < 2.5 && Math.abs(perp) < 1.1) {
          const side = plan.side;
          tx = h.x + toRim.x * 1.8 + nx * side * 1.25;
          tz = h.z + toRim.z * 1.8 + nz * side * 1.25;
        }
      }
      h.setTarget(tx, tz, 1);
      h.face = null;
      h.intent = 'Driving to the rim';
      if (toRim.d < 1.9 || (plan.until - g.time < 0.1)) h.decisionT = 0;
      else h.decisionT = Math.min(h.decisionT, 0.18);
      break;
    }
    case 'pnr': {
      const sc = plan.screener;
      if (!sc.onCourt || !sc.plan || sc.plan.type !== 'screen') { h.plan = null; break; }
      h.setTarget(h.x, h.z, 0.3);
      h.intent = `Waiting on the screen from #${sc.num}`;
      if (sc.plan.stage === 'set') {
        const d = defenderOf(g, h);
        const nx = -toRim.z, nz = toRim.x;
        const perp = (sc.x - h.x) * nx + (sc.z - h.z) * nz;
        const side = perp >= 0 ? 1 : -1;
        startDrive(g, h, team, side, 0.25);
        if (d) d.stunT = Math.max(d.stunT, 0.25);
        h.intent = `Using the screen from #${sc.num}`;
      }
      break;
    }
    case 'probe':
      h.setTarget(plan.tx, plan.tz, 0.5);
      h.intent = 'Probing the defense';
      break;
    default:
      h.setTarget(h.x, h.z, 0.3);
      h.intent = 'Sizing up the defense';
      h.dribbling = g.time - h.catchT > 1.2;
  }
  clampCourt(h, 0.35);
}

function startDrive(g, h, team, side, bonus = 0) {
  const ev = evalDrive(g, h, team);
  const beat = clamp(ev.beat + bonus, 0, 0.97);
  h.plan = { type: 'drive', side, until: g.time + 2.6, foulChecked: false };
  const d = defenderOf(g, h);
  if (d && g.rng() < beat) d.stunT = 0.35 + g.rng() * 0.35;
  h.decisionT = 0.35;
}

function evalDrive(g, h, team) {
  const rim = rimForDir(team.dir);
  const toRim = unitTo(h.x, h.z, rim.x, rim.z);
  if (toRim.d > 11) return { v: 0, beat: 0, side: 1 };
  const d = defenderOf(g, h);
  let beat = 0.9, side = g.rng() < 0.5 ? 1 : -1;
  if (d) {
    const rx = d.x - h.x, rz = d.z - h.z;
    const nx = -toRim.z, nz = toRim.x;
    const along = rx * toRim.x + rz * toRim.z;
    const perp = rx * nx + rz * nz;
    side = perp > 0 ? -1 : 1;
    if (along > -0.2) {
      const post = toRim.d < 4.2;
      const off = post ? h.r.str * 0.5 + h.r.inside * 0.5 : ((h.r.spd + h.r.acc) / 2) * 0.45 + h.r.handle * 0.55;
      const dfs = post ? d.r.intD * 0.6 + d.r.str * 0.4 : d.r.perD * 0.65 + ((d.r.spd + d.r.acc) / 2) * 0.35;
      beat = sigmoid((off - dfs) / 11 - 0.8 + clamp((Math.hypot(rx, rz) - 1.3) * 0.7, -0.5, 1.3) + (d.stunT > 0 ? 1.5 : 0));
    }
  }
  let help = 0;
  for (const o of g.teams[1 - h.team].onCourt) {
    if (o === d) continue;
    const dd = Math.hypot(o.x - rim.x, o.z - rim.z);
    if (dd < 3.3) help += clamp((3.3 - dd) / 2.3, 0, 1) * (0.5 + o.r.intD / 200);
  }
  const base = shotInfo(g, h, rim.x - toRim.x * 1.0, rim.z - toRim.z * 1.0, { contest: { level: 0 }, moving: true });
  const pRim = base.p * (1 - clamp(help, 0, 1.6) * 0.27);
  const rimEV = pRim * 2 + 0.2;
  return { v: beat * rimEV + (1 - beat) * 0.52 - 0.04, beat, side };
}

function passLaneRisk(g, from, to) {
  let risk = 0;
  for (const d of g.teams[1 - from.team].onCourt) {
    const s = distToSegment(d.x, d.z, from.x, from.z, to.x, to.z);
    if (s.t < 0.08 || s.t > 0.97) continue;
    const r = clamp((1.4 - s.d) / 1.4, 0, 1) * (0.45 + (0.35 * d.r.stl) / 99 + (0.2 * d.r.awr) / 99);
    risk = Math.max(risk, r);
  }
  return risk;
}

function evalPass(g, h, t, team) {
  const d = Math.hypot(t.x - h.x, t.z - h.z);
  if (d < 2.2 || d > 17) return null;
  if (t.action || t.airborne) return null;
  let risk = passLaneRisk(g, h, t);
  let lob = false;
  if (risk > 0.35 && d > 5) { lob = true; risk *= 0.45; }
  const passT = d / 12;
  const front = inFrontcourt(team, t);
  let v;
  if (!front) v = holdValue(g, team) * 0.9;
  else {
    const s = shotInfo(g, t, t.x, t.z, { catchShoot: true, lookahead: passT + 0.25 });
    // An open receiver can also attack a closeout.
    const td = defenderOf(g, t);
    const sep = td ? Math.hypot(td.x - t.x, td.z - t.z) : 6;
    const attack = sep > 2.5 ? 0.95 + (t.r.handle - 70) * 0.004 : 0;
    v = Math.max(s.ev, attack, holdValue(g, team) * 0.97 + 0.03);
  }
  v = v * (1 - risk * 0.9) - risk * 0.35 - 0.02;
  v += (h.r.pass - 70) * 0.0025;
  if (t === h.passer && g.time - h.catchT < 1.5) v -= 0.12;
  return { v, lob };
}

// Stylistic preference layered on top of pure expected value, so shot
// selection reflects each player's strengths (and isn't all threes and layups).
function shotTendency(p, type) {
  if (type === 'three') return (p.r.three - 74) * 0.003 - 0.1;
  if (type === 'jumper') return (p.r.mid - 68) * 0.005 + 0.1;
  if (type === 'floater') return (p.r.inside + p.r.mid - 136) * 0.002 + 0.03;
  return 0;
}

function decide(g, h, team) {
  const rim = rimForDir(team.dir);
  const dRim = Math.hypot(h.x - rim.x, h.z - rim.z);
  const front = inFrontcourt(team, h);
  const justCaught = g.time - h.catchT < 0.9;
  const driving = h.plan && h.plan.type === 'drive';
  const hv = holdValue(g, team);
  const opts = [];

  if (front && dRim < 10.5) {
    const s = shotInfo(g, h, h.x, h.z, { catchShoot: justCaught, offDribble: !justCaught, moving: driving || h.speed > 2 });
    // Players with a scorer's mentality shoot a little more.
    const ego = (h.ovr - 72) * 0.003;
    const foulBonus = s.type === 'layup' || s.type === 'dunk' ? 0.22 : s.type === 'floater' ? 0.08 : 0;
    opts.push({ t: 'shoot', v: s.ev + ego + foulBonus + shotTendency(h, s.type), s });
  }
  if (front) {
    if (!driving || dRim > 1.9) {
      const dr = evalDrive(g, h, team);
      const slash = ((h.r.inside + h.r.spd + h.r.handle) / 3 - 68) * 0.004;
      opts.push({ t: 'drive', v: dr.v + slash + (driving ? 0.12 : 0), side: dr.side });
    }
  } else {
    // Fast break if nobody is back.
    const defsBack = g.teams[1 - team.idx].onCourt.filter((d) => Math.hypot(d.x - rim.x, d.z - rim.z) < Math.hypot(h.x - rim.x, h.z - rim.z) + 1).length;
    opts.push({ t: 'advance', v: hv + 0.3, fast: defsBack <= 1 });
  }
  for (const t of team.onCourt) {
    if (t === h) continue;
    const pv = evalPass(g, h, t, team);
    if (pv) opts.push({ t: 'pass', v: pv.v, to: t, lob: pv.lob });
  }
  if (front && !(driving && dRim < 1.9)) opts.push({ t: 'probe', v: hv });

  const sigma = 0.02 + (1 - h.r.awr / 99) * 0.1;
  let best = null, bv = -1e9;
  for (const o of opts) {
    const v = o.v + gauss(g.rng) * sigma;
    if (v > bv) { bv = v; best = o; }
  }
  h.decisionT = 0.6 + g.rng() * 0.7;
  if (!best) return;
  switch (best.t) {
    case 'shoot':
      g.startShot(h, best.s);
      break;
    case 'drive':
      if (!driving) startDrive(g, h, team, best.side);
      else h.decisionT = 0.2;
      break;
    case 'advance':
      h.plan = { type: 'advance', fast: best.fast, until: g.time + 1.5 };
      h.decisionT = 0.6;
      if (best.fast) team.mode = 'transition';
      break;
    case 'pass':
      g.startPass(h, best.to, best.lob);
      break;
    case 'probe': {
      if (h.plan && h.plan.type === 'pnr') break;
      // Move to a nearby perimeter spot, staying away from teammates.
      const u = clamp(uOf(team.dir, h.x) + (g.rng() - 0.5) * 3, 6.5, 10.5);
      const v = clamp(h.z * team.dir + (g.rng() - 0.5) * 5, -6, 6);
      const pt = toCourt(team.dir, u, v);
      h.plan = { type: 'probe', tx: pt.x, tz: pt.z, until: g.time + 1.5 + g.rng() };
      h.decisionT = 0.7 + g.rng() * 0.7;
      break;
    }
  }
}

function offBallThink(g, p, team, dt) {
  if (p.action) return;
  p.dribbling = false;
  p.pose = 'none';
  const rim = rimForDir(team.dir);
  const h = g.ball.holder;
  p.face = { x: g.ball.x, z: g.ball.z };

  if (team.mode === 'transition') {
    let u, v, spd = 1;
    const side = p.z * team.dir >= 0 ? 1 : -1;
    if (p.posIdx <= 2) { u = p.posIdx === 0 ? 8 : 2.5 + p.posIdx; v = side * 6.3; }
    else if (p.posIdx === 3) { u = 8.5; v = side * 2.5; spd = 0.85; }
    else { u = p.r.spd > 62 ? 1.8 : 7; v = side * 1.4; spd = p.r.spd > 62 ? 1 : 0.8; }
    const pt = toCourt(team.dir, u, v);
    p.setTarget(pt.x, pt.z, spd);
    p.intent = p.posIdx >= 4 && u < 3 ? 'Rim running' : 'Filling the lane';
    clampCourt(p);
    return;
  }

  if (!p.spot) p.spot = freeSpot(g, team, p);
  const plan = p.plan;
  if (plan && plan.type === 'screen') { screenThink(g, p, team, dt); return; }
  if (plan && plan.type === 'cut') {
    p.setTarget(plan.tx, plan.tz, 1);
    p.intent = 'Cutting to the basket';
    if (g.time > plan.until || Math.hypot(p.x - plan.tx, p.z - plan.tz) < 0.5) {
      p.plan = null;
      p.spot = freeSpot(g, team, p);
    }
    return;
  }
  if (plan && plan.type === 'roll') {
    p.setTarget(plan.tx, plan.tz, 1);
    p.intent = plan.pop ? 'Popping for a jumper' : 'Rolling to the rim';
    if (g.time > plan.until) { p.plan = null; p.spot = freeSpot(g, team, p); }
    return;
  }

  let sp = spotPos(team, p.spot);
  if (h && Math.hypot(sp.x - h.x, sp.z - h.z) < 2.6) {
    p.spot = freeSpot(g, team, p);
    sp = spotPos(team, p.spot);
  }
  p.setTarget(sp.x, sp.z, 0.7);
  p.intent = 'Spacing the floor';

  p.moveT -= dt;
  if (p.moveT <= 0) {
    p.moveT = 2.5 + g.rng() * 3.5;
    const d = defenderOf(g, p);
    const pd = d ? Math.hypot(d.x - p.x, d.z - p.z) : 5;
    const dRim = Math.hypot(p.x - rim.x, p.z - rim.z);
    const ballWatching = d && pd > 2.4;
    const cutChance = 0.1 + (p.r.awr - 60) / 250 + (ballWatching ? 0.25 : 0) + (p.posIdx >= 3 ? 0.05 : 0);
    const r = g.rng();
    if (dRim > 3 && r < cutChance) {
      const side = p.z * team.dir >= 0 ? 1 : -1;
      const pt = toCourt(team.dir, 1.4, side * 0.8);
      p.plan = { type: 'cut', tx: pt.x, tz: pt.z, until: g.time + 2.2 };
      p.spot = null;
    } else if (r < cutChance + 0.35) {
      p.spot = freeSpot(g, team, p);
    }
  }
  clampCourt(p);
}

function screenThink(g, p, team, dt) {
  const h = g.ball.holder;
  const plan = p.plan;
  plan.t += dt;
  const rim = rimForDir(team.dir);
  if (!h || h.team !== team.idx || plan.t > 5) { p.plan = null; p.spot = freeSpot(g, team, p); return; }
  const d = defenderOf(g, h);
  if (plan.stage === 'move') {
    if (!d) { p.plan = null; return; }
    // Stand on the defender's hip, on the side the screener is coming from.
    const toRim = unitTo(h.x, h.z, rim.x, rim.z);
    const nx = -toRim.z, nz = toRim.x;
    const side = (p.x - h.x) * nx + (p.z - h.z) * nz >= 0 ? 1 : -1;
    const tx = d.x + nx * side * 0.7 - toRim.x * 0.15;
    const tz = d.z + nz * side * 0.7 - toRim.z * 0.15;
    p.setTarget(tx, tz, 0.9);
    p.intent = `Setting a screen for #${h.num}`;
    if (Math.hypot(p.x - tx, p.z - tz) < 0.45) { plan.stage = 'set'; plan.t = 0; }
    if (plan.t > 3.2) { p.plan = null; p.spot = freeSpot(g, team, p); }
  } else if (plan.stage === 'set') {
    p.setTarget(p.x, p.z, 0);
    p.intent = `Screening for #${h.num}`;
    if (plan.t > 1.0) {
      const pop = p.r.three >= 66 || p.r.mid >= 72;
      const side = p.z * team.dir >= 0 ? 1 : -1;
      const pt = pop ? toCourt(team.dir, 6.9, side * 5.2) : toCourt(team.dir, 1.3, side * 0.6);
      p.plan = { type: 'roll', pop, tx: pt.x, tz: pt.z, until: g.time + 2.5 };
    }
  }
}

// ---------------------------------------------------------------- defense

export function assignMatchups(g, defTeam) {
  const off = g.teams[1 - defTeam.idx].onCourt;
  const defs = [...defTeam.onCourt].sort((a, b) => a.posIdx - b.posIdx);
  const offs = [...off].sort((a, b) => a.posIdx - b.posIdx);
  defs.forEach((d, i) => { d.man = offs[i]; });
}

export function defenseThink(g, team, dt, handler, bx, bz) {
  const offTeam = g.teams[1 - team.idx];
  const rim = rimForDir(offTeam.dir);
  if (team.onCourt.some((d) => !d.man || !d.man.onCourt)) assignMatchups(g, team);

  // Is the ball handler getting to the rim? Pick a helper.
  let helper = null;
  if (handler) {
    const onBall = defenderOf(g, handler);
    const hd = Math.hypot(handler.x - rim.x, handler.z - rim.z);
    const beaten = onBall && (onBall.stunT > 0 || Math.hypot(onBall.x - rim.x, onBall.z - rim.z) > hd + 0.3 || Math.hypot(onBall.x - handler.x, onBall.z - handler.z) > 2.3);
    if (hd < 6.5 && (beaten || hd < 3)) {
      const px = lerp(handler.x, rim.x, 0.45), pz = lerp(handler.z, rim.z, 0.45);
      let bd = 1e9;
      for (const d of team.onCourt) {
        if (d === onBall || d.stunT > 0) continue;
        const reaction = d.r.awr / 99;
        const s = Math.hypot(d.x - px, d.z - pz) - d.posIdx * 0.4 - reaction * 1.2;
        if (s < bd) { bd = s; helper = d; }
      }
      if (helper && g.rng() > 0.4 + helper.r.awr / 200) helper = null; // late rotation
      if (helper) team.helper = helper;
    }
    if (team.helper && (hd > 7 || !team.helper.onCourt)) team.helper = null;
    if (!helper && team.helper && hd < 7) helper = team.helper;
  }

  for (const d of team.onCourt) {
    if (d.action) continue;
    d.pose = 'defend';
    d.dribbling = false;
    if (d === helper) {
      const u = unitTo(handler.x, handler.z, rim.x, rim.z);
      d.setTarget(handler.x + u.x * 0.95, handler.z + u.z * 0.95, 1);
      d.face = { x: handler.x, z: handler.z };
      d.intent = `Helping on #${handler.num}`;
      continue;
    }
    const m = d.man;
    if (!m) continue;
    if (m === handler) onBallD(g, d, m, rim, dt);
    else offBallD(g, d, m, rim, bx, bz);
  }
}

function onBallD(g, d, h, rim, dt) {
  const u = unitTo(h.x, h.z, rim.x, rim.z);
  const threat = u.d > 7.2 ? h.r.three : h.r.mid;
  let gap = 1.05 + (70 - threat) * 0.012 - (d.r.perD - 70) * 0.004;
  if (u.d > 9.3) gap += (u.d - 9.3) * 0.45;
  gap = clamp(gap, 0.75, 6);
  const wx = h.x + u.x * gap, wz = h.z + u.z * gap;
  const tau = 0.05 + (1 - d.r.awr / 99) * 0.12 + (1 - d.r.perD / 99) * 0.12;
  const k = Math.min(1, dt / tau);
  if (d.stunT <= 0) {
    d.lagX += (wx - d.lagX) * k;
    d.lagZ += (wz - d.lagZ) * k;
  }
  d.setTarget(d.lagX, d.lagZ, d.stunT > 0 ? 0.6 : 0.8 + 0.2 * (d.r.perD / 99));
  d.face = { x: h.x, z: h.z };
  d.intent = u.d > 9.5 ? `Picking up #${h.num}` : `Guarding #${h.num} on the ball`;
}

function offBallD(g, d, m, rim, bx, bz) {
  const u = unitTo(m.x, m.z, rim.x, rim.z);
  let gap = clamp(u.d * 0.22, 0.8, 7);
  const threat = u.d > 7.2 ? m.r.three : u.d > 3.5 ? m.r.mid : m.r.inside;
  const sag = clamp(0.2 + (70 - threat) * 0.012 + (u.d > 8 ? 0.1 : 0), 0.05, 0.5);
  let tx = m.x + u.x * gap, tz = m.z + u.z * gap;
  tx = lerp(tx, bx, sag * 0.45);
  tz = lerp(tz, bz, sag * 0.45);
  if (u.d < 2.2) { tx = m.x + u.x * 0.55; tz = m.z + u.z * 0.55; }
  // Out of position and behind the play: sprint back.
  const behind = Math.hypot(d.x - rim.x, d.z - rim.z) > Math.hypot(bx - rim.x, bz - rim.z) + 2;
  d.setTarget(tx, tz, behind ? 1 : 0.85);
  d.face = { x: lerp(m.x, bx, 0.5), z: lerp(m.z, bz, 0.5) };
  d.lagX = d.x; d.lagZ = d.z;
  d.intent = behind ? 'Sprinting back on defense' : `Guarding #${m.num}`;
  clampCourt(d);
}

// ---------------------------------------------------------------- ball in the air

export function looseBallThink(g, dt) {
  const ball = g.ball;
  const shotTeam = ball.shot ? ball.shot.shooter.team : null;
  const land = predictLanding(ball, 1.9);
  if (ball.pass) {
    const recv = ball.pass.to;
    for (const p of g.onCourt()) {
      if (p.action) continue;
      if (p === recv) {
        p.setTarget(ball.pass.tx, ball.pass.tz, 1);
        p.face = { x: ball.x, z: ball.z };
        p.pose = 'catch';
        p.intent = 'Calling for the ball';
      } else if (p.team !== recv.team) {
        if (p.man === recv) {
          const rim = rimForDir(g.teams[recv.team].dir);
          const u = unitTo(ball.pass.tx, ball.pass.tz, rim.x, rim.z);
          p.setTarget(ball.pass.tx + u.x * 1.0, ball.pass.tz + u.z * 1.0, 1);
          p.intent = `Closing out on #${recv.num}`;
        }
      }
    }
    return;
  }

  const rimInfo = ball.shot && !ball.shot.ft ? rimForDir(g.teams[shotTeam].dir) : null;
  const shotUp = ball.shot && !ball.shot.rimHit && ball.y > 2.2;
  for (const p of g.onCourt()) {
    if (p.action) continue;
    p.dribbling = false;
    p.face = { x: ball.x, z: ball.z };
    if (shotUp && rimInfo) {
      // Shot in the air: crash or get back, defenders box out.
      if (p.team === shotTeam) {
        const crash = p.r.reb >= 62 || p.posIdx >= 3;
        if (crash && Math.hypot(p.x - rimInfo.x, p.z - rimInfo.z) < 8) {
          const u = unitTo(rimInfo.x, rimInfo.z, p.x, p.z);
          p.setTarget(rimInfo.x + u.x * 1.6, rimInfo.z + u.z * 1.6, 1);
          p.intent = 'Crashing the glass';
        } else if (p.posIdx === 0) {
          p.setTarget(0 + g.teams[shotTeam].dir * -2, p.z * 0.5, 0.8);
          p.intent = 'Getting back';
        } else {
          p.setTarget(p.x, p.z, 0.2);
          p.intent = 'Watching the shot';
        }
      } else {
        const m = p.man;
        if (m && Math.hypot(m.x - rimInfo.x, m.z - rimInfo.z) < 6.5) {
          const u = unitTo(m.x, m.z, rimInfo.x, rimInfo.z);
          p.setTarget(m.x + u.x * 0.7, m.z + u.z * 0.7, 1);
          p.face = { x: m.x, z: m.z };
          p.intent = `Boxing out #${m.num}`;
          p.pose = 'boxout';
        } else {
          const u = unitTo(rimInfo.x, rimInfo.z, p.x, p.z);
          p.setTarget(rimInfo.x + u.x * 2.4, rimInfo.z + u.z * 2.4, 0.8);
          p.intent = 'Finding a body to box out';
        }
      }
      continue;
    }
    // Loose ball or rebound: chase it if close enough.
    const lx = ball.y > 1.9 ? land.x : ball.x;
    const lz = ball.y > 1.9 ? land.z : ball.z;
    const dd = Math.hypot(p.x - lx, p.z - lz);
    if (dd < 6 || ball.y < 1.2) {
      p.setTarget(lx, lz, 1);
      p.intent = ball.y > 1.5 ? 'Going for the rebound' : 'Diving for the loose ball';
      p.pose = 'rebound';
      // Time the jump for a high ball.
      const hd = Math.hypot(p.x - ball.x, p.z - ball.z);
      if (hd < 1.3 && ball.vy < 1 && ball.y > p.standReach - 0.1 && ball.y < p.standReach + p.jumpHeight() + 0.35) {
        p.startJump(1);
      }
    } else {
      p.setTarget(p.x, p.z, 0.3);
      p.intent = 'Waiting on the loose ball';
    }
  }
}
