// Headless calibration: runs full games and prints league-style averages.
// Usage: node tools/simtest.js [games] [periodSeconds]
import { Game } from '../js/sim/game.js';
import { PRESET_TEAMS } from '../js/data/teams.js';

const N = +process.argv[2] || 10;
const PL = +process.argv[3] || 720;
const dt = 1 / 60;
const tot = {};
const add = (k, v) => (tot[k] = (tot[k] || 0) + v);
let steps = 0, games = 0, ot = 0;
const t0 = Date.now();
const mins = {};
const shotLog = [];
for (let g = 0; g < N; g++) {
  const a = PRESET_TEAMS[g % PRESET_TEAMS.length];
  const b = PRESET_TEAMS[(g + 1 + (g >> 2)) % PRESET_TEAMS.length];
  if (a === b) continue;
  const game = new Game(a, b, { seed: 1000 + g, periodLen: PL });
  game.shotLog = shotLog;
  let s = 0;
  while (!game.over && s < 60 * 60 * 200) { game.step(dt); s++; }
  steps += s;
  games++;
  if (!game.over) console.log('GAME DID NOT FINISH', game.phase, game.period, game.clock);
  if (game.period > 4) ot++;
  for (const t of game.teams) {
    for (const p of t.roster) {
      for (const k in p.stats) add(k, p.stats[k]);
      const key = p.rosterIdx;
      mins[key] = (mins[key] || 0) + p.stats.min / 60;
    }
  }
  const [x, y] = game.teams;
  if (process.env.BOX && g === 0) for (const t of game.teams) { console.log(t.name); for (const p of t.roster) console.log(`  ${String(p.rosterIdx).padStart(2)} ${p.pos.padEnd(2)} ${p.name.padEnd(22)} ovr ${p.ovr} min ${(p.stats.min / 60).toFixed(1).padStart(4)} pts ${String(p.stats.pts).padStart(2)} ${p.stats.fgm}-${p.stats.fga} 3p ${p.stats.tpm}-${p.stats.tpa} ft ${p.stats.ftm}-${p.stats.fta} reb ${p.stats.oreb + p.stats.dreb} ast ${p.stats.ast} stl ${p.stats.stl} blk ${p.stats.blk} to ${p.stats.tov} pf ${p.stats.pf} +/- ${p.stats.pm}`); }
  console.log(`${x.abbr} ${x.score} - ${y.abbr} ${y.score}  (periods ${game.period}, sim ${(s * dt / 60).toFixed(1)} game-min)`);
}
const tg = games * 2;
const f = (k) => (tot[k] / tg).toFixed(1);
console.log(`\nPer team per game over ${games} games (${((Date.now() - t0) / 1000).toFixed(1)}s, ${(steps / ((Date.now() - t0) / 1000) / 1000).toFixed(0)}k steps/s)`);
console.log(`PTS ${f('pts')}  FGM-A ${f('fgm')}-${f('fga')} (${(100 * tot.fgm / tot.fga).toFixed(1)}%)  3PM-A ${f('tpm')}-${f('tpa')} (${(100 * tot.tpm / tot.tpa).toFixed(1)}%)  FTM-A ${f('ftm')}-${f('fta')} (${(100 * tot.ftm / tot.fta).toFixed(1)}%)`);
console.log(`REB ${((tot.oreb + tot.dreb) / tg).toFixed(1)} (OREB ${f('oreb')}, OREB% ${(100 * tot.oreb / (tot.oreb + tot.dreb)).toFixed(1)})  AST ${f('ast')}  STL ${f('stl')}  BLK ${f('blk')}  TOV ${f('tov')}  PF ${f('pf')}`);
const poss = (tot.fga - tot.oreb + 0.44 * tot.fta + tot.tov) / tg;
console.log(`Possessions ~${poss.toFixed(1)}  OT games ${ot}`);
console.log('Avg minutes by roster slot:', Object.keys(mins).map((k) => (mins[k] / tg).toFixed(1)).join(' '));

const byKind = {};
for (const sh of shotLog) {
  const k = sh.kind + (sh.oreb ? '(putback)' : '');
  const o = byKind[k] || (byKind[k] = { n: 0, make: 0, p: 0, c: 0, d: 0, sc: 0 });
  o.n++; o.make += sh.make ? 1 : 0; o.p += sh.p; o.c += sh.contest; o.d += sh.d; o.sc += sh.sc;
}
for (const k in byKind) {
  const o = byKind[k];
  console.log(`${k.padEnd(18)} per-team-game ${(o.n / tg).toFixed(1).padStart(5)}  intended ${(100 * o.make / o.n).toFixed(0)}%  avgP ${(o.p / o.n).toFixed(2)}  contest ${(o.c / o.n).toFixed(2)}  dist ${(o.d / o.n).toFixed(1)}  shotclock ${(o.sc / o.n).toFixed(1)}`);
}
