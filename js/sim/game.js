// Game rules, clocks and flow. The Game owns all sim state and advances it with
// fixed time steps via step(dt). It has no DOM or rendering dependencies.
import { Ball, stepBall, rimForDir, solveLaunch, solveTimed, RIMS } from './physics.js';
import { Player, movePlayer } from './player.js';
import {
  HALF_L, HALF_W, RIM_Y, RIM_R, PLAYER_R, SHOT_CLOCK, OREB_CLOCK, BALL_R, FT_U, toCourt, isThree,
  inBounds, uOf,
} from './constants.js';
import { makeRng, clamp, gauss, weightedPick, fmtClock } from '../util.js';
import { shotInfo, ftProb, rollBlock, rollShootingFoul } from './shotmodel.js';
import { offenseThink, defenseThink, looseBallThink, assignMatchups, assignSpots, defenderOf, inFrontcourt } from './ai.js';

const SHOT_WORDS = {
  dunk: 'dunk', layup: 'layup', floater: 'floater', jumper: 'jumper', three: '3-pointer',
};

export class Game {
  constructor(teamA, teamB, opts = {}) {
    this.seed = opts.seed ?? Math.floor(Math.random() * 1e9);
    this.rng = makeRng(this.seed);
    this.periodLen = opts.periodLen ?? 720;
    this.otLen = Math.min(300, this.periodLen);
    this.fatigueScale = Math.sqrt(720 / this.periodLen);
    this.teams = [teamA, teamB].map((td, i) => this.makeTeam(td, i));
    this.players = this.teams.flatMap((t) => t.roster);
    this.ball = new Ball();
    this.period = 1;
    this.clock = this.periodLen;
    this.shotClock = SHOT_CLOCK;
    this.clockRunning = false;
    this.shotClockOn = true;
    this.phase = 'pregame';
    this.phaseT = 0;
    this.time = 0;
    this.offense = null;
    this.events = [];
    this.eventSeq = 0;
    this.over = false;
    this.tipWinner = null;
    this.reboundable = false;
    this.buzzerPending = false;
    this.inb = null; this.ft = null; this.dead = null; this.brk = null;
    this.pendingFT = null;
    this.teams[0].dir = 1;
    this.teams[1].dir = -1;
    for (const t of this.teams) assignMatchups(this, t);
    this.startJumpBall();
    this.log(`Tip-off: ${this.teams[1].name} at ${this.teams[0].name}`, null, 'period');
  }

  makeTeam(td, idx) {
    const roster = td.players.map((pd, i) => new Player(pd, idx, i));
    const team = {
      idx, name: td.name, abbr: td.abbr, primary: td.primary, secondary: td.secondary,
      roster, onCourt: roster.slice(0, 5), score: 0, fouls: 0, timeouts: 7,
      dir: 1, periodScores: [], mode: 'transition', modeT: 0, playT: 5, runAgainst: 0, lastTO: -999,
      helper: null,
    };
    team.rotation = [...roster].sort((a, b) => b.ovr - a.ovr);
    const sign = idx === 0 ? -1 : 1;
    roster.forEach((p, i) => {
      p.onCourt = i < 5;
      p.benchX = sign * (2.6 + i * 0.62);
      p.benchZ = HALF_W + 1.9;
      p.x = p.benchX; p.z = p.benchZ; p.tx = p.x; p.tz = p.z;
    });
    return team;
  }

  onCourt() {
    return this.teams[0].onCourt.concat(this.teams[1].onCourt);
  }

  log(text, team = null, kind = 'info') {
    this.events.push({ id: ++this.eventSeq, text, team, kind, period: this.period, clock: this.clock, score: [this.teams[0].score, this.teams[1].score] });
    if (this.events.length > 600) this.events.splice(0, this.events.length - 600);
  }

  periodName(n = this.period) {
    return n <= 4 ? `Q${n}` : n === 5 ? 'OT' : `${n - 4}OT`;
  }

  // ------------------------------------------------------------------ main step
  step(dt) {
    if (this.over) { this.idleStep(dt); return; }
    this.time += dt;
    this.phaseT += dt;
    const evs = [];
    switch (this.phase) {
      case 'jumpball': this.updateJumpBall(dt); break;
      case 'live': this.think(dt); break;
      case 'inbound': this.updateInbound(dt); break;
      case 'ft': this.updateFT(dt); break;
      case 'dead': this.updateDead(dt); break;
      case 'timeout': this.updateBreak(dt); break;
      case 'periodEnd': this.updateBreak(dt); break;
    }
    this.updateActions(dt);
    this.movePlayers(dt);
    this.updateBall(dt, evs);
    if (this.phase === 'live' || this.phase === 'inbound' || this.phase === 'jumpball' || this.phase === 'ft') {
      this.handleBallEvents(evs);
      this.resolveContacts(dt);
    }
    if (this.phase === 'live') this.handlerPressure(dt);
    this.updateClocks(dt);
    this.updateFatigue(dt);
  }

  idleStep(dt) {
    this.time += dt;
    this.movePlayers(dt);
    const evs = [];
    this.updateBall(dt, evs);
  }

  think(dt) {
    const ball = this.ball;
    if (ball.state === 'held' && ball.holder) {
      const off = this.teams[ball.holder.team];
      offenseThink(this, off, dt);
      defenseThink(this, this.teams[1 - off.idx], dt, ball.holder, ball.x, ball.z);
    } else {
      looseBallThink(this, dt);
    }
  }

  // ------------------------------------------------------------------ movement
  movePlayers(dt) {
    for (const p of this.players) {
      if (!p.onCourt) {
        p.setTarget(p.benchX, p.benchZ, 0.45);
        p.face = { x: p.benchX, z: 0 };
        p.pose = 'none';
        p.action = null;
      }
      movePlayer(p, dt, this.ball.holder === p);
    }
    // Player-player collisions (circles), heavier players move less.
    const on = this.onCourt();
    for (let i = 0; i < on.length; i++) {
      for (let j = i + 1; j < on.length; j++) {
        const a = on[i], b = on[j];
        if (Math.abs(a.y - b.y) > 0.6) continue;
        const dx = b.x - a.x, dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        const min = PLAYER_R * 2;
        if (d >= min || d < 1e-6) continue;
        const nx = dx / d, nz = dz / d, ov = min - d;
        const ma = this.mass(a), mb = this.mass(b);
        const ka = mb / (ma + mb), kb = ma / (ma + mb);
        a.x -= nx * ov * ka; a.z -= nz * ov * ka;
        b.x += nx * ov * kb; b.z += nz * ov * kb;
        const rv = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
        if (rv < 0) {
          a.vx += nx * rv * ka; a.vz += nz * rv * ka;
          b.vx -= nx * rv * kb; b.vz -= nz * rv * kb;
        }
        if (this.phase === 'live' && a.team !== b.team) this.contactFoulCheck(a, b, -rv);
      }
    }
  }

  mass(p) {
    let m = 70 + p.r.str * 0.45 + p.heightCm * 0.15;
    if (p.plan && p.plan.type === 'screen' && p.plan.stage === 'set') m *= 3;
    if (p.pose === 'boxout') m *= 1.3;
    return m;
  }

  contactFoulCheck(a, b, closing) {
    const h = this.ball.holder;
    if (!h || (a !== h && b !== h)) return;
    const d = a === h ? b : a;
    if (!h.plan || h.plan.type !== 'drive' || h.plan.foulChecked || closing < 2.2) return;
    h.plan.foulChecked = true;
    if (this.rng() > 0.2) return;
    const set = d.speed < 0.9;
    if (this.rng() < (set ? 0.5 : 0.1)) {
      this.commitFoul(h, d, 'offensive');
    } else {
      this.commitFoul(d, h, 'blocking');
    }
  }

  // ------------------------------------------------------------------ actions
  startShot(p, info) {
    const kind = info.type;
    const rim = rimForDir(this.teams[p.team].dir);
    p.action = {
      type: 'shoot', kind, t: 0,
      jumpAt: kind === 'jumper' || kind === 'three' ? 0.15 : 0.1,
      release: kind === 'dunk' ? 0.42 : kind === 'layup' ? 0.36 : kind === 'floater' ? 0.33 : 0.42,
      x0: p.x, z0: p.z, info, released: false,
    };
    p.plan = null;
    p.dribbling = false;
    p.pose = 'shoot';
    p.face = { x: rim.x, z: rim.z };
    p.intent = `Shooting a ${SHOT_WORDS[kind] || kind}`;
    // Nearby defenders leap to contest.
    for (const d of this.teams[1 - p.team].onCourt) {
      const dd = Math.hypot(d.x - p.x, d.z - p.z);
      if (dd < 2.3 && !d.airborne && !d.action) {
        d.action = { type: 'contest', t: 0, jumpAt: 0.12 + this.rng() * 0.15 + (1 - d.r.awr / 99) * 0.1, shooter: p };
        d.pose = 'contest';
      }
    }
  }

  startPass(p, to, lob) {
    p.action = { type: 'pass', t: 0, release: 0.16, to, lob };
    p.plan = null;
    p.pose = 'pass';
    p.dribbling = false;
    p.face = { x: to.x, z: to.z };
    p.intent = `Passing to #${to.num}`;
  }

  updateActions(dt) {
    for (const p of this.onCourt()) {
      const a = p.action;
      if (!a) continue;
      a.t += dt;
      if (a.type === 'shoot') {
        const rim = rimForDir(this.teams[p.team].dir);
        if (a.kind === 'layup' || a.kind === 'dunk') {
          const dx = rim.x - p.x, dz = rim.z - p.z, d = Math.hypot(dx, dz) || 1;
          const stop = a.kind === 'dunk' ? 0.35 : 0.7;
          p.setTarget(p.x + (dx / d) * Math.max(0, d - stop), p.z + (dz / d) * Math.max(0, d - stop), 1);
        } else if (a.kind !== 'ft') {
          p.setTarget(p.x, p.z, 0);
        }
        if (a.t >= a.jumpAt && !a.jumped) {
          a.jumped = true;
          const frac = a.kind === 'ft' ? 0.04 : a.kind === 'three' ? 0.32 : a.kind === 'jumper' ? 0.42 : a.kind === 'floater' ? 0.55 : 1;
          p.startJump(frac);
        }
        if (a.t >= a.release && !a.released) {
          a.released = true;
          if (this.ball.holder === p) {
            if (a.kind === 'ft') this.releaseFT(p);
            else this.releaseShot(p);
          }
        }
        if (a.released && a.t > a.release + 0.15 && !p.airborne) { p.action = null; p.pose = 'none'; }
        if (a.t > 3) p.action = null;
      } else if (a.type === 'pass') {
        p.setTarget(p.x, p.z, 0.2);
        if (a.t >= a.release && !a.released) {
          a.released = true;
          if (this.ball.holder === p) this.releasePass(p, a.to, a.lob);
        }
        if (a.t > a.release + 0.2) { p.action = null; p.pose = 'none'; }
      } else if (a.type === 'contest') {
        const s = a.shooter;
        p.setTarget(p.x + (s.x - p.x) * 0.3, p.z + (s.z - p.z) * 0.3, 0.6);
        p.face = { x: s.x, z: s.z };
        if (a.t >= a.jumpAt && !a.jumped) { a.jumped = true; p.startJump(0.8); }
        if (a.jumped && a.t > a.jumpAt + 0.1 && !p.airborne) { p.action = null; p.pose = 'defend'; }
        if (a.t > 2) p.action = null;
      }
    }
  }

  releaseShot(p) {
    const team = this.teams[p.team];
    const rim = rimForDir(team.dir);
    const a = p.action;
    const kind = a.kind;
    const info = shotInfo(this, p, p.x, p.z, { moving: kind === 'dunk' || kind === 'layup', offDribble: a.info && !a.info.catchShoot });
    const pts = isThree(team.dir, a.x0, a.z0) ? 3 : 2;
    let pMake = kind === 'dunk' ? Math.max(info.p, 0.85) : info.p;
    const blocker = rollBlock(this, p, { ...info, type: kind });
    const fouler = blocker ? null : rollShootingFoul(this, p, { ...info, type: kind });
    if (fouler) pMake *= 0.55;
    p.stats.fga++;
    if (pts === 3) p.stats.tpa++;
    const ball = this.ball;
    const fx = Math.sin(p.facing), fz = Math.cos(p.facing);
    ball.holder = null;
    ball.state = 'air';
    ball.lastTouch = p;
    ball.pass = null;
    this.reboundable = true;
    const assistFrom = p.passer && p.passer.team === p.team && this.time - p.catchT < 3.5 ? p.passer : null;

    if (blocker) {
      const u = { x: (p.x - rim.x), z: (p.z - rim.z) };
      const ul = Math.hypot(u.x, u.z) || 1;
      const sp = 3 + this.rng() * 4;
      ball.vx = (u.x / ul) * sp + (this.rng() - 0.5) * 4;
      ball.vz = (u.z / ul) * sp + (this.rng() - 0.5) * 4;
      ball.vy = (this.rng() - 0.3) * 3;
      ball.y = Math.max(ball.y, p.reach - 0.1);
      ball.shot = null;
      ball.lastTouch = blocker;
      blocker.stats.blk++;
      blocker.pose = 'block';
      if (!blocker.airborne) blocker.startJump(1);
      this.log(`${this.nm(blocker)} BLOCKS ${this.nm(p)}'s ${SHOT_WORDS[kind] || 'shot'}!`, blocker.team, 'block');
      p.intent = 'Got blocked';
      return;
    }

    const make = this.rng() < pMake;
    if (this.shotLog) this.shotLog.push({ kind, p: pMake, contest: info.contest, d: info.d, make, sc: this.shotClock, sinceCatch: this.time - p.catchT, fouled: !!fouler, oreb: this.lastOreb && this.time - this.lastOreb < 2 });
    const from = { x: ball.x, y: ball.y, z: ball.z };
    let target;
    if (make) {
      const j = kind === 'dunk' ? 0 : 0.05;
      target = { x: rim.x + (this.rng() - 0.5) * j, y: RIM_Y, z: rim.z + (this.rng() - 0.5) * j };
    } else {
      // Aim so the ball catches iron: long / short / left / right.
      const toShooter = Math.atan2(p.z - rim.z, p.x - rim.x);
      const r = this.rng();
      let ang;
      if (r < 0.4) ang = toShooter + Math.PI + (this.rng() - 0.5) * 0.9; // long
      else if (r < 0.75) ang = toShooter + (this.rng() - 0.5) * 0.9; // short
      else ang = toShooter + (this.rng() < 0.5 ? 1 : -1) * (Math.PI / 2 + (this.rng() - 0.5) * 0.6);
      const off = kind === 'dunk' ? 0.26 : 0.21 + this.rng() * 0.16;
      target = { x: rim.x + Math.cos(ang) * off, y: RIM_Y, z: rim.z + Math.sin(ang) * off };
    }
    if (kind === 'dunk') {
      // Hammer it down through (or off the back of) the ring from just above it.
      const ux = p.x - rim.x, uz = p.z - rim.z, ul = Math.hypot(ux, uz) || 1;
      ball.x = rim.x + (ux / ul) * 0.12; ball.z = rim.z + (uz / ul) * 0.12;
      ball.y = RIM_Y + 0.28;
      const v = solveTimed(ball, target, 0.11);
      ball.vx = v.vx; ball.vy = Math.min(v.vy, -2.5); ball.vz = v.vz;
      p.pose = 'dunk';
    } else {
      // Never release from underneath the hoop: the ball would hit the rim from below.
      const hx = from.x - rim.x, hz = from.z - rim.z;
      const hd = Math.hypot(hx, hz);
      if (hd < 0.8) {
        const ux = hd > 1e-3 ? hx / hd : -Math.sign(rim.x), uz = hd > 1e-3 ? hz / hd : 0;
        from.x = rim.x + ux * 0.8; from.z = rim.z + uz * 0.8;
        ball.x = from.x; ball.z = from.z;
      }
      const dist = Math.hypot(target.x - from.x, target.z - from.z);
      const angDeg = kind === 'layup' ? 58 : kind === 'floater' ? 56 : kind === 'three' ? 47 : 50 - dist * 0.3;
      // Steep enough that the ball is descending (>= ~48 deg) when it reaches the rim.
      const entry = 1.0 + 0.6 * clamp((3 - dist) / 2, 0, 1);
      const minAng = Math.atan(entry + (2 * (target.y - from.y)) / Math.max(0.3, dist));
      const v = solveLaunch(from, target, Math.max((angDeg * Math.PI) / 180, minAng));
      ball.vx = v.vx; ball.vy = v.vy; ball.vz = v.vz;
    }
    ball.shot = {
      shooter: p, pts, make, kind, fouledBy: fouler, rimHit: false, t: this.time,
      assistFrom, clockAtRelease: this.clock, ft: false,
    };
    ball.spin = -8;
    this.lastShotTeam = p.team;
    p.intent = 'Watching the shot';
    void fx; void fz;
  }

  releasePass(p, to, lob) {
    const ball = this.ball;
    const d = Math.hypot(to.x - ball.x, to.z - ball.z);
    const speed = (10 + p.r.pass * 0.045) * (lob ? 0.6 : 1);
    const t = Math.max(0.25, d / speed);
    let tx = to.x + to.vx * t * 0.85, tz = to.z + to.vz * t * 0.85;
    const sig = (1 - p.r.pass / 99) * 0.45 + 0.05;
    tx += gauss(this.rng) * sig; tz += gauss(this.rng) * sig;
    if (this.rng() < 0.014 * Math.pow(75 / p.r.pass, 2)) {
      const a = this.rng() * Math.PI * 2, e = 2.5 + this.rng() * 2;
      tx += Math.cos(a) * e; tz += Math.sin(a) * e;
    }
    const ty = to.h * (lob ? 0.85 : 0.62);
    const v = solveTimed(ball, { x: tx, y: ty, z: tz }, lob ? t * 1.3 : t);
    ball.vx = v.vx; ball.vy = v.vy; ball.vz = v.vz;
    ball.holder = null;
    ball.state = 'air';
    ball.lastTouch = p;
    ball.shot = null;
    ball.pass = { from: p, to, t0: this.time, dur: lob ? t * 1.3 : t, tx, tz };
    ball.lostBy = p;
    to.plan = null;
  }

  // ------------------------------------------------------------------ ball
  updateBall(dt, evs) {
    const ball = this.ball;
    if (ball.state === 'held' && ball.holder) {
      this.attachBall(ball.holder, dt);
    } else if (ball.state === 'air') {
      stepBall(ball, dt, evs, this.rng);
    }
  }

  attachBall(p, dt) {
    const ball = this.ball;
    const fx = Math.sin(p.facing), fz = Math.cos(p.facing);
    const rx = -Math.cos(p.facing), rz = Math.sin(p.facing);
    ball.vx = p.vx; ball.vz = p.vz; ball.vy = 0;
    if (p.action && p.action.type === 'shoot') {
      const k = Math.min(1, p.action.t / Math.max(0.1, p.action.release));
      const low = p.h * 0.62, high = p.h * 1.1;
      ball.x = p.x + fx * 0.22; ball.z = p.z + fz * 0.22;
      ball.y = p.y + low + (high - low) * k;
      if (p.action.kind === 'layup' || p.action.kind === 'dunk') ball.y = p.y + low + (p.h * 1.22 - low) * k;
    } else if (p.dribbling && !(p.action && p.action.type === 'pass')) {
      p.dribblePhase = (p.dribblePhase || 0) + dt * (2.1 + p.speed * 0.25) * Math.PI;
      const s = Math.abs(Math.sin(p.dribblePhase));
      ball.x = p.x + fx * 0.32 + rx * 0.3 + p.vx * 0.05;
      ball.z = p.z + fz * 0.32 + rz * 0.3 + p.vz * 0.05;
      ball.y = BALL_R + s * (p.h * 0.46 - BALL_R);
    } else {
      ball.x = p.x + fx * 0.3; ball.z = p.z + fz * 0.3;
      ball.y = p.y + p.h * 0.62;
    }
  }

  handleBallEvents(evs) {
    const ball = this.ball;
    for (const e of evs) {
      if (e.type === 'score') {
        this.onScore(e.rim);
      } else if (e.type === 'rim' || e.type === 'board') {
        if (ball.shot) {
          if (!ball.shot.rimHit && e.type === 'rim') {
            ball.shot.rimHit = true;
            if (!ball.shot.ft) this.shotClockOn = false;
          }
          if (e.type === 'board') ball.shot.boardHit = true;
        }
        if (this.phase === 'ft' && ball.shot && ball.shot.ft && ball.shot.last && e.type === 'rim' && !ball.shot.make) {
          // Missed final free throw: ball is live.
          this.phase = 'live';
          this.ft = null;
          this.reboundable = true;
          this.clockRunning = true;
        }
      } else if (e.type === 'floor' || e.type === 'floorRest') {
        if (ball.shot) this.resolveMiss();
        if (ball.pass) ball.pass = null;
      } else if (e.type === 'oob') {
        if (ball.state === 'air' && (this.phase === 'live' || this.phase === 'jumpball' || (this.phase === 'inbound' && this.inb && this.inb.stage === 'passing'))) this.outOfBounds(e.x, e.z);
        return;
      }
      if (this.phase !== 'live' && this.phase !== 'ft' && this.phase !== 'inbound' && this.phase !== 'jumpball') return;
    }
    // A missed shot is decided once it drops well below the rim after hitting iron.
    if (ball.shot && ball.state === 'air' && ball.shot.rimHit && ball.y < RIM_Y - 0.4 && ball.vy < 0) {
      const rim = rimForDir(this.teams[ball.shot.shooter.team].dir);
      if (Math.hypot(ball.x - rim.x, ball.z - rim.z) > RIM_R) this.resolveMiss();
    }
  }

  onScore(rim) {
    const ball = this.ball;
    const shot = ball.shot;
    // The team scoring is the one attacking this rim.
    const teamIdx = this.teams[0].dir === rim.side ? 0 : 1;
    const team = this.teams[teamIdx];
    if (shot && shot.ft) {
      const p = shot.shooter;
      p.stats.ftm++; p.stats.pts += 1;
      this.addPoints(team, 1);
      shot.scored = true;
      ball.shot = null;
      this.reboundable = false;
      if (this.ft) this.ft.lastResult = 'make';
      this.log(`${this.nm(p)} makes free throw ${this.ft ? this.ft.i + 1 : ''} of ${this.ft ? this.ft.n : ''}`, teamIdx, 'ft');
      if (this.phase === 'live') this.afterMadeBasket(teamIdx);
      return;
    }
    let pts = 2, shooter = null;
    if (shot) { pts = shot.pts; shooter = shot.shooter; }
    else if (ball.lastTouch && ball.lastTouch.team === teamIdx) shooter = ball.lastTouch;
    if (shooter && shooter.team !== teamIdx) shooter = null;
    this.addPoints(team, pts);
    if (shooter) {
      shooter.stats.pts += pts;
      shooter.stats.fgm++;
      if (pts === 3) shooter.stats.tpm++;
      if (!shot) shooter.stats.fga++;
    }
    let text = shooter ? `${this.nm(shooter)} ${shot && shot.kind === 'dunk' ? 'throws it down' : 'makes'} ${shot ? describeShot(shot) : 'a putback'}` : `${team.abbr} scores`;
    if (shot && shot.assistFrom && shot.assistFrom !== shooter) {
      shot.assistFrom.stats.ast++;
      text += ` (${this.nm(shot.assistFrom)} assists)`;
    }
    const andOne = shot && shot.fouledBy;
    if (andOne) text += ' — AND ONE!';
    if (shot && shot.clockAtRelease > 0 && this.clock <= 0) text += ' at the buzzer!';
    this.log(text, teamIdx, pts === 3 ? 'three' : 'score');
    ball.shot = null;
    this.reboundable = false;
    if (andOne) {
      this.commitFoul(shot.fouledBy, shooter, 'shooting-made');
      this.deadBall(1.4, () => this.startFreeThrows(shooter, 1));
      return;
    }
    if (this.buzzerPending) { this.buzzerPending = false; this.endPeriod(); return; }
    this.afterMadeBasket(teamIdx);
  }

  addPoints(team, pts) {
    team.score += pts;
    team.periodScores[this.period - 1] = (team.periodScores[this.period - 1] || 0) + pts;
    const other = this.teams[1 - team.idx];
    other.runAgainst += pts;
    team.runAgainst = 0;
    for (const p of team.onCourt) p.stats.pm += pts;
    for (const p of other.onCourt) p.stats.pm -= pts;
  }

  afterMadeBasket(scoringTeam) {
    const late = this.period >= 4 && this.clock < 120;
    this.clockRunning = !late && this.clock > 0;
    this.startInbound(1 - scoringTeam, 'made');
  }

  resolveMiss() {
    const ball = this.ball;
    const shot = ball.shot;
    if (!shot) return;
    ball.shot = null;
    if (shot.ft) {
      this.log(`${this.nm(shot.shooter)} misses free throw ${this.ft ? this.ft.i + 1 : ''} of ${this.ft ? this.ft.n : ''}`, shot.shooter.team, 'miss');
      if (this.ft) this.ft.lastResult = 'miss';
      return;
    }
    this.log(`${this.nm(shot.shooter)} misses ${describeShot(shot)}`, shot.shooter.team, 'miss');
    if (shot.fouledBy) {
      this.commitFoul(shot.fouledBy, shot.shooter, 'shooting');
      this.deadBall(1.4, () => this.startFreeThrows(shot.shooter, shot.pts));
      return;
    }
    if (this.buzzerPending) { this.buzzerPending = false; this.endPeriod(); }
  }

  // Catches, rebounds, interceptions and loose-ball recoveries.
  resolveContacts(dt) {
    const ball = this.ball;
    if (ball.state !== 'air') return;
    if (this.phase === 'ft') return;
    if (this.phase === 'inbound' && this.inb && this.inb.stage === 'retrieve') {
      const w = this.inb.who;
      if (Math.hypot(w.x - ball.x, w.z - ball.z) < 0.7 && ball.y < w.reach) {
        ball.state = 'held'; ball.holder = w; ball.shot = null; ball.pass = null;
        this.inb.stage = 'walk';
      }
      return;
    }
    // Goaltending rule: nobody touches a shot on its way up / above the rim before it hits iron.
    if (ball.shot && !ball.shot.rimHit && (ball.y > RIM_Y - 0.25 || ball.vy > 0)) return;

    const pass = ball.pass;
    if (pass) {
      const r = pass.to;
      const hd = Math.hypot(r.x - ball.x, r.z - ball.z);
      if (r.onCourt && hd < 0.75 && ball.y < r.reach + 0.15 && ball.y > 0.15) {
        this.gainControl(r, 'pass', pass.from);
        return;
      }
      // Defenders in the lane can pick it off.
      for (const d of this.teams[1 - pass.from.team].onCourt) {
        const dd = Math.hypot(d.x - ball.x, d.z - ball.z);
        if (dd > 0.85 || ball.y > d.reach + 0.3 || this.time - pass.t0 < 0.08) continue;
        const pr = (0.04 + 0.12 * d.r.stl / 99 + 0.04 * d.r.awr / 99) * (1 - dd / 0.85) * 60 * dt;
        if (this.rng() < pr) {
          if (this.rng() < 0.55) {
            ball.deflectedBy = d;
            this.gainControl(d, 'intercept', pass.from);
          } else {
            ball.deflectedBy = d;
            ball.lastTouch = d;
            ball.pass = null;
            ball.vx = ball.vx * -0.3 + (this.rng() - 0.5) * 4;
            ball.vz = ball.vz * -0.3 + (this.rng() - 0.5) * 4;
            ball.vy = Math.abs(ball.vy) * 0.3 + 1;
            this.log(`${this.nm(d)} deflects the pass`, d.team, 'info');
          }
          return;
        }
      }
      if (this.time - pass.t0 > pass.dur + 0.4) ball.pass = null;
      return;
    }

    // Loose ball / rebound.
    const cands = [];
    for (const p of this.onCourt()) {
      const hd = Math.hypot(p.x - ball.x, p.z - ball.z);
      const reachR = 0.55 + (p.airborne ? 0.15 : 0);
      if (hd < reachR && ball.y < p.reach + 0.2) cands.push(p);
    }
    if (!cands.length) return;
    const high = ball.y > 1.7;
    const grabP = high ? 0.3 : 0.75;
    if (this.rng() > grabP * 60 * dt) return;
    const offIdx = this.offense;
    const winner = weightedPick(this.rng, cands, (p) => {
      let w = Math.pow(p.r.reb / 70, 2.2) * (0.7 + p.r.str / 300) * (p.heightCm / 200) ** 2;
      if (!high) w = (p.r.awr + p.r.spd) / 140;
      if (high && offIdx != null && p.team !== offIdx) w *= 2.3; // defensive positioning edge
      return w;
    });
    this.gainControl(winner, 'loose');
  }

  gainControl(p, how, passer = null) {
    const ball = this.ball;
    if (ball.shot) this.resolveMiss();
    if (this.phase === 'dead') return;
    ball.state = 'held';
    ball.holder = p;
    ball.pass = null;
    ball.lastTouch = p;
    const prevOff = this.offense;
    if (this.reboundable) {
      this.reboundable = false;
      if (prevOff === p.team) {
        p.stats.oreb++;
        this.lastOreb = this.time;
        this.shotClock = Math.max(this.shotClock, OREB_CLOCK);
        if (this.shotClock > OREB_CLOCK && !this.shotClockOn) this.shotClock = OREB_CLOCK;
        this.log(`${this.nm(p)} grabs the offensive rebound`, p.team, 'reb');
      } else {
        p.stats.dreb++;
        this.log(`${this.nm(p)} with the defensive rebound`, p.team, 'reb');
      }
    }
    if (prevOff !== p.team) {
      if (prevOff != null) {
        if (ball.deflectedBy && ball.deflectedBy.team === p.team) {
          ball.deflectedBy.stats.stl++;
          if (ball.lostBy) ball.lostBy.stats.tov++;
          this.log(`${this.nm(ball.deflectedBy)} steals it from ${ball.lostBy ? this.nm(ball.lostBy) : 'the offense'}`, p.team, 'steal');
        } else if (ball.lostBy && ball.lostBy.team !== p.team) {
          ball.lostBy.stats.tov++;
          this.log(`Turnover by ${this.nm(ball.lostBy)}`, ball.lostBy.team, 'tov');
        }
      }
      this.shotClock = SHOT_CLOCK;
      this.offense = p.team;
      const t = this.teams[p.team];
      t.mode = 'transition'; t.modeT = 0;
      for (const q of t.onCourt) { q.plan = null; q.spot = null; }
      this.teams[1 - p.team].helper = null;
    }
    ball.deflectedBy = null;
    ball.lostBy = null;
    this.shotClockOn = true;
    p.catchT = this.time;
    p.passer = how === 'pass' ? passer : null;
    p.decisionT = how === 'pass' ? 0.12 + (1 - p.r.awr / 99) * 0.35 : 0.3;
    p.plan = null;
    if (this.phase === 'inbound' || this.phase === 'jumpball') {
      this.phase = 'live';
      this.inb = null;
      if (this.clock > 0) this.clockRunning = true;
      const t = this.teams[p.team];
      if (inFrontcourt(t, p)) { t.mode = 'half'; assignSpots(this, t); }
    }
  }

  outOfBounds(x, z) {
    const ball = this.ball;
    const last = ball.lastTouch;
    if (ball.shot) {
      const shot = ball.shot;
      ball.shot = null;
      if (shot.fouledBy) {
        this.commitFoul(shot.fouledBy, shot.shooter, 'shooting');
        this.deadBall(1.4, () => this.startFreeThrows(shot.shooter, shot.pts));
        return;
      }
    }
    const team = last ? 1 - last.team : this.offense != null ? 1 - this.offense : 0;
    if (this.offense != null && team !== this.offense && last && last.team === this.offense) {
      last.stats.tov++;
      this.log(`${this.nm(last)} loses it out of bounds`, last.team, 'tov');
    } else {
      this.log(`Out of bounds, ${this.teams[team].abbr} ball`, team, 'info');
    }
    const spot = this.boundarySpot(x, z);
    const keep = team === this.offense;
    this.reboundable = false;
    ball.pass = null;
    this.deadBall(1.3, () => this.startInbound(team, keep ? 'keep' : 'side', spot));
  }

  boundarySpot(x, z) {
    if (Math.abs(x) > HALF_L - 0.3 && Math.abs(z) < HALF_W - 0.5) {
      return { x: Math.sign(x) * (HALF_L + 0.45), z: clamp(z, -HALF_W + 1, HALF_W - 1) < 0 ? -3.5 : 3.5 };
    }
    return { x: clamp(x, -HALF_L + 1.5, HALF_L - 1.5), z: (z >= 0 ? 1 : -1) * (HALF_W + 0.45) };
  }

  // On-ball pressure: strips, reach-ins, travels.
  handlerPressure(dt) {
    const h = this.ball.holder;
    if (!h || this.ball.state !== 'held' || h.action) return;
    const d = defenderOf(this, h);
    if (d && !d.action && d.stunT <= 0 && h.dribbling) {
      const dd = Math.hypot(d.x - h.x, d.z - h.z);
      if (dd < 1.05) {
        const strip = 0.036 * Math.pow(d.r.stl / 70, 2) * Math.pow(70 / h.r.handle, 1.6) * dt;
        const reach = 0.03 * (1.3 - (d.r.awr / 99) * 0.55) * (d.r.stl / 70) * dt;
        const r = this.rng();
        if (r < strip) {
          const b = this.ball;
          b.state = 'air'; b.holder = null;
          b.vx = (this.rng() - 0.5) * 5; b.vz = (this.rng() - 0.5) * 5; b.vy = 1.5;
          b.deflectedBy = d; b.lostBy = h; b.lastTouch = d;
          h.plan = null;
          this.log(`${this.nm(d)} pokes the ball loose from ${this.nm(h)}`, d.team, 'info');
          return;
        } else if (r < strip + reach) {
          this.commitFoul(d, h, 'reach');
          return;
        }
      }
    }
    if (h.speed > 1 && this.rng() < 0.004 * Math.pow(70 / h.r.handle, 2) * dt) {
      h.stats.tov++;
      this.log(`${this.nm(h)} called for traveling`, h.team, 'tov');
      this.deadBall(1.2, () => this.startInbound(1 - h.team, 'side', this.boundarySpot(h.x, h.z >= 0 ? HALF_W : -HALF_W)));
    }
  }

  // ------------------------------------------------------------------ fouls
  commitFoul(fouler, fouled, kind) {
    const team = this.teams[fouler.team];
    fouler.fouls++;
    fouler.stats.pf++;
    team.fouls++;
    const kindText = {
      shooting: 'shooting foul', 'shooting-made': 'shooting foul', blocking: 'blocking foul',
      reach: 'reaching foul', offensive: 'offensive foul (charge)', loose: 'loose ball foul',
    }[kind];
    this.log(`Foul on ${this.nm(fouler)} — ${kindText} (${fouler.fouls} PF)`, fouler.team, 'foul');
    if (fouler.fouls >= 6 && !fouler.fouledOut) {
      fouler.fouledOut = true;
      this.log(`${this.nm(fouler)} has fouled out!`, fouler.team, 'foul');
    }
    if (kind === 'shooting' || kind === 'shooting-made') return;
    const ball = this.ball;
    ball.pass = null;
    if (kind === 'offensive') {
      fouler.stats.tov++; // offensive foul: the fouler is the ball handler
      this.deadBall(1.4, () => this.startInbound(1 - fouler.team, 'side', this.boundarySpot(fouler.x, fouler.z >= 0 ? HALF_W : -HALF_W)));
      return;
    }
    const bonus = team.fouls >= 5;
    if (bonus) {
      this.deadBall(1.4, () => this.startFreeThrows(fouled, 2));
    } else {
      this.deadBall(1.4, () => this.startInbound(fouled.team, 'keep', this.boundarySpot(fouled.x, fouled.z >= 0 ? HALF_W : -HALF_W)));
    }
  }

  // ------------------------------------------------------------------ dead balls
  deadBall(delay, next) {
    this.phase = 'dead';
    this.phaseT = 0;
    this.clockRunning = false;
    this.dead = { t: delay, next };
    this.ball.pass = null;
    if (this.ball.state === 'held') {
      this.ball.state = 'air';
      this.ball.holder = null;
      this.ball.vx *= 0.3; this.ball.vz *= 0.3;
    }
    for (const p of this.onCourt()) { p.plan = null; if (p.action && p.action.type !== 'shoot') p.action = null; }
  }

  updateDead(dt) {
    for (const p of this.onCourt()) {
      p.setTarget(p.x, p.z, 0.2);
      p.pose = 'none';
      p.intent = 'Dead ball';
    }
    this.dead.t -= dt;
    if (this.dead.t <= 0) {
      const next = this.dead.next;
      this.dead = null;
      if (this.clock <= 0 && !this.pendingPeriodEnd) {
        // no-op: period end is handled by updateClocks
      }
      if (this.coachTimeout(next)) return;
      this.coachSubs();
      next();
    }
  }

  coachTimeout(next) {
    for (const t of this.teams) {
      if (t.timeouts > 0 && t.runAgainst >= 8 && this.time - t.lastTO > 90) {
        t.timeouts--;
        t.lastTO = this.time;
        t.runAgainst = 0;
        this.teams[1 - t.idx].runAgainst = 0;
        this.log(`Timeout ${t.name} (${t.timeouts} left)`, t.idx, 'timeout');
        this.phase = 'timeout';
        this.phaseT = 0;
        this.brk = { t: 6, next: () => { this.coachSubs(); next(); } };
        for (const p of this.onCourt()) p.stamina = Math.min(1, p.stamina + 0.06);
        return true;
      }
    }
    return false;
  }

  updateBreak(dt) {
    for (const p of this.onCourt()) {
      const huddle = this.teams[p.team].onCourt.indexOf(p);
      const bx = (p.team === 0 ? -5 : 5) + (huddle - 2) * 0.6;
      p.setTarget(bx, HALF_W - 0.6 - (huddle % 2) * 0.7, 0.45);
      p.face = { x: p.team === 0 ? -5 : 5, z: HALF_W - 1 };
      p.pose = 'none';
      p.intent = this.phase === 'timeout' ? 'In the huddle' : 'Break between periods';
    }
    this.ball.state = 'air';
    this.brk.t -= dt;
    if (this.brk.t <= 0) {
      const next = this.brk.next;
      this.brk = null;
      next();
    }
  }

  coachSubs() {
    for (const t of this.teams) this.teamSubs(t);
  }

  teamSubs(team) {
    const margin = Math.abs(this.teams[0].score - this.teams[1].score);
    const garbage = this.period >= 4 && this.clock < 200 && margin >= 20;
    const rank = (p) => team.rotation.indexOf(p);
    const depth = 10;
    const foulTrouble = (p) => this.period <= 4 && !(this.period === 4 && this.clock < 360) && p.fouls >= this.period + 1;
    const avail = (b) => !b.onCourt && !b.fouledOut;

    for (let i = 0; i < team.onCourt.length; i++) {
      const p = team.onCourt[i];
      const tired = p.stamina < (p.rosterIdx < 5 ? 0.76 : 0.79);
      const need = p.fouledOut || tired || foulTrouble(p) || (garbage && rank(p) < 8);
      if (!need) continue;
      let best = null, bs = -1e9;
      for (const b of team.roster) {
        if (!avail(b)) continue;
        const pd = Math.abs(b.posIdx - p.posIdx);
        if (!p.fouledOut && pd > 1) continue;
        if (!garbage && rank(b) >= depth && !p.fouledOut) continue;
        if (!garbage && b.stamina < 0.82 && !p.fouledOut) continue;
        if (foulTrouble(b) && !p.fouledOut) continue;
        let s = garbage ? rank(b) * 10 - pd * 5 : b.ovr * (0.6 + 0.4 * b.stamina) - pd * 15;
        if (s > bs) { bs = s; best = b; }
      }
      if (best) this.doSub(team, p, best);
      else if (p.fouledOut) {
        const any = team.roster.find(avail);
        if (any) this.doSub(team, p, any);
      }
    }
    if (garbage) return;
    // Bring rested starters / regulars back for lesser players.
    const prio = (p) => (p.rosterIdx < 5 ? 100 : 0) + p.ovr;
    for (const b of [...team.roster].sort((x, y) => prio(y) - prio(x)).slice(0, 8)) {
      if (!avail(b) || b.stamina < 0.92 || foulTrouble(b)) continue;
      let worst = null;
      for (const p of team.onCourt) {
        if (Math.abs(p.posIdx - b.posIdx) > 1) continue;
        if (prio(p) < prio(b) - 1 && (p.stamina < 0.95 || p.rosterIdx >= 5)) {
          if (!worst || prio(p) < prio(worst)) worst = p;
        }
      }
      if (worst) this.doSub(team, worst, b);
    }
  }

  doSub(team, out, inn) {
    const i = team.onCourt.indexOf(out);
    if (i < 0) return;
    team.onCourt[i] = inn;
    out.onCourt = false;
    inn.onCourt = true;
    inn.x = team.idx === 0 ? -1.2 : 1.2;
    inn.z = HALF_W + 0.9;
    inn.vx = inn.vz = 0; inn.y = 0; inn.vy = 0;
    inn.tx = inn.x; inn.tz = inn.z;
    inn.man = out.man;
    inn.spot = out.spot;
    inn.plan = null; inn.action = null;
    out.plan = null; out.action = null; out.man = null;
    for (const d of this.teams[1 - team.idx].onCourt) if (d.man === out) d.man = inn;
    if (team.helper === out) team.helper = null;
    if (this.ball.holder === out) this.ball.holder = inn;
    this.log(`SUB ${team.abbr}: ${this.nm(inn)} in for ${this.nm(out)}`, team.idx, 'sub');
  }

  // ------------------------------------------------------------------ inbounds
  startInbound(teamIdx, kind, spot = null) {
    const team = this.teams[teamIdx];
    const ball = this.ball;
    this.phase = 'inbound';
    this.phaseT = 0;
    if (this.offense !== teamIdx) {
      this.offense = teamIdx;
      this.shotClock = SHOT_CLOCK;
    } else if (kind === 'keep') {
      this.shotClock = Math.max(this.shotClock, OREB_CLOCK);
    } else {
      this.shotClock = SHOT_CLOCK;
    }
    this.shotClockOn = true;
    this.reboundable = false;
    team.mode = 'transition'; team.modeT = 0;
    for (const t of this.teams) { t.helper = null; for (const p of t.onCourt) { p.plan = null; p.spot = null; } }
    let who;
    if (kind === 'made') {
      const rimSide = -team.dir;
      spot = { x: rimSide * (HALF_L + 0.5), z: (this.rng() < 0.5 ? -1 : 1) * 1.3 };
      const bigs = [...team.onCourt].sort((a, b) => b.posIdx - a.posIdx || Math.hypot(a.x - ball.x, a.z - ball.z) - Math.hypot(b.x - ball.x, b.z - ball.z));
      who = bigs.find((p) => p.posIdx >= 3) || bigs[0];
    } else {
      const cands = [...team.onCourt].sort((a, b) => Math.hypot(a.x - spot.x, a.z - spot.z) - Math.hypot(b.x - spot.x, b.z - spot.z));
      who = cands.find((p) => p.posIdx !== 0) || cands[0];
      ball.state = 'dead';
      ball.holder = null;
      ball.shot = null;
    }
    this.inb = { team: teamIdx, kind, spot, who, stage: kind === 'made' ? 'retrieve' : 'walk', t: 0 };
    for (const t of this.teams) assignMatchups(this, t);
  }

  updateInbound(dt) {
    const inb = this.inb;
    const team = this.teams[inb.team];
    const w = inb.who;
    const ball = this.ball;
    if (!w.onCourt) { inb.who = team.onCourt.find((p) => p.posIdx !== 0) || team.onCourt[0]; return; }
    w.pose = 'none';
    if (inb.stage === 'retrieve') {
      w.setTarget(ball.x, ball.z, 0.8);
      w.intent = 'Grabbing the ball to inbound';
      if (ball.state === 'air' && Math.abs(ball.x) > HALF_L + 1.5) { ball.state = 'held'; ball.holder = w; inb.stage = 'walk'; }
      if (this.phaseT > 6) { ball.state = 'held'; ball.holder = w; inb.stage = 'walk'; }
    } else if (inb.stage === 'walk') {
      w.setTarget(inb.spot.x, inb.spot.z, 0.7);
      w.intent = 'Taking the ball out';
      if (ball.holder !== w) {
        if (Math.hypot(w.x - inb.spot.x, w.z - inb.spot.z) < 0.5) { ball.state = 'held'; ball.holder = w; }
      }
      if (ball.holder === w && Math.hypot(w.x - inb.spot.x, w.z - inb.spot.z) < 0.35) { inb.stage = 'ready'; inb.t = 0; }
      if (this.phaseT > 9) { w.x = inb.spot.x; w.z = inb.spot.z; ball.state = 'held'; ball.holder = w; inb.stage = 'ready'; inb.t = 0; }
    } else if (inb.stage === 'ready') {
      inb.t += dt;
      w.setTarget(inb.spot.x, inb.spot.z, 0.3);
      w.face = { x: 0, z: 0 };
      w.intent = 'Looking to inbound';
      if (inb.t > 1.0 && !w.action) {
        const mates = team.onCourt.filter((p) => p !== w);
        const best = mates.reduce((bb, p) => {
          const d = Math.hypot(p.x - w.x, p.z - w.z);
          if ((d > 14 && inb.t < 3) || d < 1.5) return bb;
          let open = 9;
          for (const o of this.teams[1 - team.idx].onCourt) open = Math.min(open, Math.hypot(o.x - p.x, o.z - p.z));
          const s = open * 1.5 + (p === inb.recv1 ? 2.5 : p === inb.recv2 ? 1 : 0) - d * 0.1;
          return !bb || s > bb.s ? { p, s } : bb;
        }, null);
        if (best && (inb.t > 1.6 || best.s > 5)) {
          this.startPass(w, best.p, false);
          inb.stage = 'passing';
          inb.t = 0;
        }
      }
    } else if (inb.stage === 'passing') {
      inb.t += dt;
      if (ball.holder === w && !w.action && inb.t > 0.6) { inb.stage = 'ready'; inb.t = 0; }
    }
    // Everyone else gets into position.
    const bx = inb.spot.x, bz = inb.spot.z;
    const cx = clamp(bx, -HALF_L + 2, HALF_L - 2) * 0.85, cz = clamp(bz, -HALF_W + 2, HALF_W - 2) * 0.5;
    const intoX = cx - bx, intoZ = cz - bz, il = Math.hypot(intoX, intoZ) || 1;
    if (!inb.recv1 || !inb.recv1.onCourt || inb.recv1 === w) {
      const hs = team.onCourt.filter((p) => p !== w).sort((a, b) => (b.r.handle + b.r.pass) - (a.r.handle + a.r.pass));
      inb.recv1 = hs[0]; inb.recv2 = hs[1];
    }
    for (const p of team.onCourt) {
      if (p === w || p.action) continue;
      if (this.ball.pass && this.ball.pass.to === p) {
        p.setTarget(this.ball.pass.tx, this.ball.pass.tz, 1);
        continue;
      }
      if (p === inb.recv1 || (p === inb.recv2 && inb.kind !== 'made')) {
        const off = p === inb.recv1 ? 0 : 3;
        p.setTarget(bx + (intoX / il) * 4.2 + (intoZ / il) * off, bz + (intoZ / il) * 4.2 - (intoX / il) * off, 0.8);
        p.intent = 'Getting open for the inbound';
      } else {
        const side = p.posIdx % 2 ? 1 : -1;
        const deep = inb.kind === 'made' ? 5 + p.posIdx * 1.5 : 3 + p.posIdx;
        const pt = toCourt(team.dir, deep, side * (2 + (p.posIdx === 2 ? 4 : 1)));
        p.setTarget(pt.x, pt.z, 0.8);
        p.intent = 'Setting up';
      }
      p.face = { x: bx, z: bz };
      p.pose = 'none';
      p.tx = clamp(p.tx, -HALF_L + 0.4, HALF_L - 0.4);
      p.tz = clamp(p.tz, -HALF_W + 0.4, HALF_W - 0.4);
    }
    defenseThink(this, this.teams[1 - team.idx], dt, w, bx, bz);
  }

  // ------------------------------------------------------------------ free throws
  startFreeThrows(shooter, n) {
    if (!shooter.onCourt) {
      shooter = this.teams[shooter.team].onCourt.reduce((a, b) => (b.r.ft > a.r.ft ? b : a));
    }
    this.phase = 'ft';
    this.phaseT = 0;
    this.clockRunning = false;
    this.offense = shooter.team;
    this.ft = { shooter, n, i: 0, stage: 'setup', t: 0 };
    const ball = this.ball;
    ball.state = 'dead'; ball.holder = null; ball.shot = null; ball.pass = null;
    this.reboundable = false;
    const offT = this.teams[shooter.team], defT = this.teams[1 - shooter.team];
    const dir = offT.dir;
    const spotFor = (u, v) => toCourt(dir, u, v);
    const shooterPos = spotFor(FT_U + 0.15, 0);
    shooter.setTarget(shooterPos.x, shooterPos.z, 0.5);
    const defLane = [[2.2, 2.75], [2.2, -2.75], [4.0, 2.75]];
    const offLane = [[3.1, 2.75], [3.1, -2.75]];
    const defs = [...defT.onCourt].sort((a, b) => b.posIdx - a.posIdx);
    const offs = [...offT.onCourt].filter((p) => p !== shooter).sort((a, b) => b.posIdx - a.posIdx);
    defs.forEach((p, i) => {
      const s = i < 3 ? spotFor(defLane[i][0], defLane[i][1]) : spotFor(9.5, i === 3 ? 3 : -3);
      p.setTarget(s.x, s.z, 0.5);
    });
    offs.forEach((p, i) => {
      const s = i < 2 ? spotFor(offLane[i][0], offLane[i][1]) : spotFor(9.8, i === 2 ? -1.5 : 1.5);
      p.setTarget(s.x, s.z, 0.5);
    });
    this.ftTargets = new Map(this.onCourt().map((p) => [p, { x: p.tx, z: p.tz }]));
  }

  updateFT(dt) {
    const ft = this.ft;
    if (!ft) return;
    const s = ft.shooter;
    const rim = rimForDir(this.teams[s.team].dir);
    for (const p of this.onCourt()) {
      const t = this.ftTargets.get(p);
      if (t) p.setTarget(t.x, t.z, 0.5);
      p.face = { x: rim.x, z: rim.z };
      p.pose = 'none';
      p.intent = p === s ? 'At the free-throw line' : 'Lined up for the free throw';
    }
    ft.t += dt;
    const ball = this.ball;
    if (ft.stage === 'setup') {
      if (ft.t > 2.0) {
        ball.state = 'held'; ball.holder = s; s.dribbling = false;
        ft.stage = 'aim'; ft.t = 0;
      }
    } else if (ft.stage === 'aim') {
      if (ft.t > 1.1 && !s.action) {
        s.action = { type: 'shoot', kind: 'ft', t: 0, jumpAt: 0.3, release: 0.45, x0: s.x, z0: s.z };
        s.pose = 'shoot';
        ft.stage = 'flight'; ft.t = 0; ft.lastResult = null;
      }
    } else if (ft.stage === 'flight') {
      if (ft.lastResult || (ft.t > 4 && !ball.shot)) {
        ft.i++;
        if (ft.i >= ft.n) {
          // Final FT made (misses switch to live play on rim contact).
          if (ft.lastResult === 'make') {
            this.ft = null;
            this.clockRunning = false;
            this.startInbound(1 - s.team, 'made');
          } else {
            this.ft = null;
            this.phase = 'live';
            this.clockRunning = this.clock > 0;
          }
        } else {
          ft.stage = 'between'; ft.t = 0;
        }
      }
    } else if (ft.stage === 'between') {
      if (ft.t > 1.2) {
        ball.state = 'held'; ball.holder = s; ball.shot = null;
        ft.stage = 'aim'; ft.t = 0;
      }
    }
  }

  releaseFT(p) {
    const ball = this.ball;
    const rim = rimForDir(this.teams[p.team].dir);
    const make = this.rng() < ftProb(p);
    p.stats.fta++;
    if (this.shotLog) this.shotLog.push({ kind: 'ft', p: ftProb(p), contest: 0, d: 4.2, make, sc: 0 });
    const last = this.ft && this.ft.i === this.ft.n - 1;
    let target;
    if (make) target = { x: rim.x + (this.rng() - 0.5) * 0.04, y: RIM_Y, z: rim.z + (this.rng() - 0.5) * 0.04 };
    else {
      const toShooter = Math.atan2(p.z - rim.z, p.x - rim.x);
      const ang = toShooter + (this.rng() < 0.55 ? Math.PI : 0) + (this.rng() - 0.5) * 0.8;
      const off = 0.22 + this.rng() * 0.1;
      target = { x: rim.x + Math.cos(ang) * off, y: RIM_Y, z: rim.z + Math.sin(ang) * off };
    }
    const dist = Math.hypot(target.x - ball.x, target.z - ball.z);
    const minAng = Math.atan(1.05 + (2 * (target.y - ball.y)) / dist);
    const v = solveLaunch(ball, target, Math.max((52 * Math.PI) / 180, minAng));
    ball.vx = v.vx; ball.vy = v.vy; ball.vz = v.vz;
    ball.state = 'air'; ball.holder = null; ball.lastTouch = p;
    ball.shot = { shooter: p, pts: 1, make, kind: 'ft', ft: true, last, rimHit: false, t: this.time, clockAtRelease: this.clock };
  }

  // ------------------------------------------------------------------ jump ball
  startJumpBall() {
    this.phase = 'jumpball';
    this.phaseT = 0;
    this.clockRunning = false;
    this.offense = null;
    const ball = this.ball;
    ball.state = 'dead'; ball.holder = null; ball.shot = null; ball.pass = null;
    ball.x = 0; ball.z = 0; ball.y = 1.6; ball.vx = ball.vy = ball.vz = 0;
    this.jb = { tossed: false, jumpers: [], winner: null };
    for (const t of this.teams) {
      const jumper = [...t.onCourt].sort((a, b) => (b.standReach + b.jumpHeight()) - (a.standReach + a.jumpHeight()))[0];
      this.jb.jumpers[t.idx] = jumper;
      const d = t.dir;
      const others = t.onCourt.filter((p) => p !== jumper);
      jumper.setTarget(-d * 0.45, 0, 0.5);
      const spots = [[-d * 2.3, 2.6], [-d * 2.3, -2.6], [-d * 5.5, 4.2], [-d * 5.5, -4.2]];
      others.forEach((p, i) => p.setTarget(spots[i][0], spots[i][1] * d, 0.5));
    }
  }

  updateJumpBall(dt) {
    const jb = this.jb;
    const ball = this.ball;
    for (const p of this.onCourt()) {
      p.face = { x: 0, z: 0 };
      p.intent = jb.jumpers.includes(p) ? 'Jumping center' : 'Waiting for the tip';
      p.pose = 'none';
    }
    if (!jb.tossed) {
      ball.x = 0; ball.z = 0; ball.y = 1.6; ball.state = 'dead';
      if (this.phaseT > 2.5) {
        jb.tossed = true;
        ball.state = 'air'; ball.y = 1.9; ball.vy = 7.2; ball.vx = 0; ball.vz = 0;
        const [a, b] = jb.jumpers;
        const sa = a.standReach + a.jumpHeight() + (a.r.awr / 99) * 0.15 + this.rng() * 0.35;
        const sb = b.standReach + b.jumpHeight() + (b.r.awr / 99) * 0.15 + this.rng() * 0.35;
        jb.winner = sa >= sb ? a : b;
      }
      return;
    }
    const w = jb.winner;
    for (const j of jb.jumpers) {
      if (!j.airborne && ball.vy < 1.5 && !j.jumped) { j.startJump(1); j.jumped = true; j.pose = 'rebound'; }
    }
    if (ball.vy < 0 && ball.y <= w.reach + 0.15 && !jb.tipped) {
      jb.tipped = true;
      for (const j of jb.jumpers) j.jumped = false;
      const team = this.teams[w.team];
      const mates = team.onCourt.filter((p) => p !== w);
      const to = mates.reduce((a, b) => (Math.hypot(b.x, b.z) < 3.5 && b.posIdx < a.posIdx ? b : a), mates[0]);
      const v = solveTimed(ball, { x: to.x, y: 1.4, z: to.z }, 0.7);
      ball.vx = v.vx; ball.vy = v.vy; ball.vz = v.vz;
      ball.lastTouch = w;
      ball.pass = { from: w, to, t0: this.time, dur: 0.7, tx: to.x, tz: to.z };
      this.tipWinner = w.team;
      this.log(`${this.nm(w)} wins the tip for ${team.abbr}`, w.team, 'info');
      this.phase = 'live';
      this.clockRunning = true;
    }
    if (this.phaseT > 8) {
      this.phase = 'live';
      this.clockRunning = true;
    }
  }

  // ------------------------------------------------------------------ clocks / periods
  updateClocks(dt) {
    if (!this.clockRunning) return;
    const runs = this.phase === 'live' || this.phase === 'inbound';
    if (!runs) return;
    this.clock -= dt;
    for (const p of this.onCourt()) p.stats.min += dt;
    if (this.phase === 'live' && this.shotClockOn && this.offense != null) {
      this.shotClock -= dt;
      if (this.shotClock <= 0 && this.clock > 0) {
        this.shotClock = 0;
        const b = this.ball;
        if (!(b.shot && b.state === 'air')) {
          const team = this.teams[this.offense];
          this.log(`Shot clock violation on ${team.name}`, team.idx, 'tov');
          const h = b.holder || b.lastTouch;
          if (h && h.team === team.idx) h.stats.tov++;
          const x = b.x, z = b.z;
          this.deadBall(1.3, () => this.startInbound(1 - team.idx, 'side', this.boundarySpot(x, z >= 0 ? HALF_W : -HALF_W)));
          return;
        }
      }
    }
    if (this.clock <= 0) {
      this.clock = 0;
      this.clockRunning = false;
      const b = this.ball;
      if (b.shot && b.state === 'air' && !b.shot.ft && b.shot.clockAtRelease > 0) {
        this.buzzerPending = true;
        return;
      }
      this.endPeriod();
    }
  }

  endPeriod() {
    const b = this.ball;
    b.shot = null; b.pass = null;
    if (b.holder) { b.state = 'air'; b.holder = null; }
    this.reboundable = false;
    this.clockRunning = false;
    const [a, c] = this.teams;
    this.log(`End of ${this.periodName()}: ${a.abbr} ${a.score} – ${c.abbr} ${c.score}`, null, 'period');
    if (this.period >= 4 && a.score !== c.score) {
      this.over = true;
      this.phase = 'final';
      const w = a.score > c.score ? a : c;
      this.log(`FINAL: ${w.name} win ${Math.max(a.score, c.score)}–${Math.min(a.score, c.score)}`, w.idx, 'final');
      for (const p of this.players) { p.action = null; p.pose = 'none'; p.intent = 'Game over'; }
      for (const p of this.onCourt()) p.setTarget(p.benchX * 0.6, p.benchZ - 1.5, 0.4);
      return;
    }
    this.phase = 'periodEnd';
    this.phaseT = 0;
    const half = this.period === 2;
    this.brk = { t: half ? 10 : 6, next: () => this.startPeriod(this.period + 1) };
    for (const p of this.players) {
      p.stamina = Math.min(1, p.stamina + (half ? 0.45 : 0.18));
      p.action = null;
    }
  }

  startPeriod(n) {
    this.period = n;
    this.clock = n <= 4 ? this.periodLen : this.otLen;
    this.shotClock = SHOT_CLOCK;
    this.shotClockOn = true;
    for (const t of this.teams) { t.fouls = 0; t.runAgainst = 0; }
    if (n === 3) for (const t of this.teams) t.dir *= -1;
    this.log(`Start of ${this.periodName()}`, null, 'period');
    this.coachSubs();
    if (n >= 5) {
      this.startJumpBall();
      return;
    }
    const tw = this.tipWinner ?? 0;
    const team = n === 4 ? tw : 1 - tw;
    const side = this.teams[team].dir;
    this.offense = null;
    this.startInbound(team, 'side', { x: -side * 0.8, z: -(HALF_W + 0.45) });
  }

  updateFatigue(dt) {
    const running = this.clockRunning;
    for (const p of this.players) {
      if (p.onCourt) {
        if (!running) continue;
        const sf = p.speed / (p.maxSpeed() || 1);
        const drain = (0.00062 + 0.0011 * sf * sf) * (1.45 - (0.9 * p.r.sta) / 99) * this.fatigueScale;
        p.stamina = Math.max(0.3, p.stamina - drain * dt);
      } else {
        p.stamina = Math.min(1, p.stamina + 0.0007 * this.fatigueScale * dt);
      }
    }
  }

  nm(p) {
    return `#${p.num} ${p.name.split(' ').slice(-1)[0]}`;
  }

  statusText() {
    const ph = this.phase;
    if (this.over) return 'FINAL';
    if (ph === 'timeout') return 'TIMEOUT';
    if (ph === 'periodEnd') return this.period === 2 ? 'HALFTIME' : `END OF ${this.periodName()}`;
    if (ph === 'ft') return 'FREE THROWS';
    if (ph === 'jumpball') return 'JUMP BALL';
    return '';
  }
}

function lerpN(a, b, t) { return a + (b - a) * t; }

function describeShot(shot) {
  const k = shot.kind;
  if (k === 'three') return 'a 3-pointer';
  if (k === 'dunk') return 'the dunk';
  if (k === 'layup') return 'a layup';
  if (k === 'floater') return 'a floater';
  return 'a jumper';
}

export { fmtClock };
