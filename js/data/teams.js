// Preset fictional teams. Rosters are generated deterministically from position
// archetypes + a team style, so every visitor sees the same presets.
import { makeRng, gauss, clamp } from '../util.js';
import { RATING_KEYS } from '../sim/constants.js';

const FIRST = [
  'Marcus', 'Darius', 'Jalen', 'Tyrese', 'Andre', 'Malik', 'Devin', 'Isaiah', 'Caleb', 'Jordan',
  'Trey', 'Xavier', 'Elijah', 'Nate', 'Bryce', 'Terrence', 'Julian', 'Cam', 'Dante', 'Rashad',
  'Kofi', 'Luka', 'Mateo', 'Anton', 'Rafael', 'Ty', 'Omar', 'Quincy', 'Derrick', 'Myles',
  'Jamal', 'Evan', 'Kendrick', 'Zion', 'Amari', 'Theo', 'Nikola', 'Sergio', 'Dominic', 'Keon',
  'Hassan', 'Victor', 'Ruben', 'Colin', 'Gavin', 'Isaac', 'Tobias', 'Wes', 'Jerome', 'Lamar',
];
const LAST = [
  'Holloway', 'Brooks', 'Whitfield', 'Okafor', 'Castellanos', 'Pryor', 'Vance', 'Mercer', 'Dawkins', 'Sutton',
  'Ferreira', 'Abara', 'Kowalski', 'Lindqvist', 'Tatum-Reed', 'Grayson', 'Ellison', 'Montague', 'Nwosu', 'Barrett',
  'Hightower', 'Oyelaran', 'Castillo', 'Draper', 'Fontaine', 'Rhodes', 'Winslow', 'Achebe', 'Maddox', 'Petrov',
  'Stroud', 'Calloway', 'Ibarra', 'Jennings', 'Kincaid', 'Laurent', 'McCray', 'Novak', 'Osei', 'Pemberton',
  'Quarles', 'Randolph', 'Sandoval', 'Thibault', 'Underwood', 'Valdez', 'Whitaker', 'Yarbrough', 'Zeller', 'Ashby',
  'Bledsoe', 'Crenshaw', 'Delacroix', 'Eastman', 'Fairbanks', 'Gentry', 'Harlan', 'Iverson-Cole', 'Jabari', 'Kessler',
];

// Archetype baselines (70 ~ league average for a player at that position).
const ARCH = {
  PG: { h: [185, 193], r: { inside: 62, mid: 72, three: 74, ft: 80, pass: 80, handle: 82, reb: 42, str: 45, spd: 84, acc: 85, vert: 70, awr: 72, perD: 68, intD: 36, stl: 68, blk: 26, sta: 80 } },
  SG: { h: [191, 198], r: { inside: 64, mid: 74, three: 76, ft: 80, pass: 65, handle: 72, reb: 46, str: 52, spd: 80, acc: 80, vert: 72, awr: 68, perD: 70, intD: 42, stl: 64, blk: 34, sta: 78 } },
  SF: { h: [198, 204], r: { inside: 68, mid: 70, three: 70, ft: 76, pass: 60, handle: 63, reb: 56, str: 62, spd: 74, acc: 72, vert: 72, awr: 68, perD: 70, intD: 58, stl: 58, blk: 48, sta: 78 } },
  PF: { h: [203, 208], r: { inside: 74, mid: 64, three: 60, ft: 70, pass: 56, handle: 50, reb: 72, str: 75, spd: 65, acc: 62, vert: 68, awr: 66, perD: 56, intD: 72, stl: 50, blk: 62, sta: 75 } },
  C: { h: [208, 216], r: { inside: 78, mid: 54, three: 38, ft: 62, pass: 50, handle: 40, reb: 84, str: 84, spd: 56, acc: 52, vert: 64, awr: 64, perD: 42, intD: 80, stl: 44, blk: 76, sta: 72 } },
};

const ROSTER_POS = ['PG', 'SG', 'SF', 'PF', 'C', 'PG', 'SG', 'SF', 'PF', 'C', 'SG', 'PF'];
// Quality offset by roster slot: starters above, deep bench below.
const SLOT_BOOST = [6, 5, 5, 5, 6, 0, -1, -1, -2, -2, -6, -7];

const STYLES = {
  shooters: { three: 8, mid: 5, ft: 4, intD: -4, reb: -3, str: -2 },
  bigs: { reb: 8, str: 7, inside: 6, intD: 6, blk: 5, spd: -4, acc: -4, three: -5, height: 3 },
  pace: { spd: 8, acc: 8, sta: 9, three: 2, reb: -3, str: -3, stl: 3 },
  passing: { pass: 10, awr: 9, handle: 4, mid: 3, spd: -2 },
  defense: { perD: 9, intD: 8, stl: 6, blk: 6, awr: 4, three: -4, mid: -2 },
  stars: { inside: 3, mid: 3, three: 3, pass: 2, handle: 2, awr: 2, perD: -2 },
};

const PRESET_DEFS = [
  { key: 'sharks', name: 'Harbor City Sharks', abbr: 'HCS', style: 'shooters', primary: '#0e7c86', secondary: '#f2f2f2', seed: 101, star: { slot: 1, keys: ['three', 'mid', 'ft', 'handle'] } },
  { key: 'titans', name: 'Iron Valley Titans', abbr: 'IVT', style: 'bigs', primary: '#7a1f1f', secondary: '#c9a227', seed: 202, star: { slot: 4, keys: ['inside', 'reb', 'blk', 'str'] } },
  { key: 'comets', name: 'Desert Comets', abbr: 'DSC', style: 'pace', primary: '#e36414', secondary: '#1b1b3a', seed: 303, star: { slot: 0, keys: ['spd', 'acc', 'handle', 'inside'] } },
  { key: 'owls', name: 'Northside Owls', abbr: 'NSO', style: 'passing', primary: '#3d2b6b', secondary: '#9fd3c7', seed: 404, star: { slot: 0, keys: ['pass', 'awr', 'handle', 'mid'] } },
  { key: 'wall', name: 'Granite Wall', abbr: 'GRW', style: 'defense', primary: '#44505c', secondary: '#e8c547', seed: 505, star: { slot: 2, keys: ['perD', 'stl', 'awr', 'inside'] } },
  { key: 'kings', name: 'Metro Kings', abbr: 'MTK', style: 'stars', primary: '#1d3fbf', secondary: '#f5d000', seed: 606, star: { slot: 2, keys: ['inside', 'mid', 'three', 'vert'] } },
];

function genTeam(def) {
  const rng = makeRng(def.seed);
  const style = STYLES[def.style];
  const usedNums = new Set();
  const players = ROSTER_POS.map((pos, slot) => {
    const arch = ARCH[pos];
    const ratings = {};
    for (const k of RATING_KEYS) {
      let v = arch.r[k] + SLOT_BOOST[slot] + (style[k] || 0) + gauss(rng) * 6;
      if (def.star.slot === slot && def.star.keys.includes(k)) v += 12;
      ratings[k] = Math.round(clamp(v, 25, 99));
    }
    let num;
    do { num = Math.floor(rng() * 45); } while (usedNums.has(num));
    usedNums.add(num);
    const h = arch.h[0] + rng() * (arch.h[1] - arch.h[0]) + (style.height || 0);
    return {
      name: `${FIRST[Math.floor(rng() * FIRST.length)]} ${LAST[Math.floor(rng() * LAST.length)]}`,
      num,
      pos,
      height: Math.round(h),
      ratings,
    };
  });
  return {
    key: def.key,
    name: def.name,
    abbr: def.abbr,
    primary: def.primary,
    secondary: def.secondary,
    players,
  };
}

export const PRESET_TEAMS = PRESET_DEFS.map(genTeam);

const POS_WEIGHTS = {
  PG: { inside: 1, mid: 1.2, three: 1.4, pass: 1.6, handle: 1.6, spd: 1.2, acc: 1.2, awr: 1.2, perD: 1, stl: 0.8 },
  SG: { inside: 1, mid: 1.4, three: 1.6, pass: 0.8, handle: 1.2, spd: 1.1, acc: 1.1, awr: 1, perD: 1.1, stl: 0.8 },
  SF: { inside: 1.2, mid: 1.2, three: 1.2, pass: 0.8, handle: 0.9, spd: 1, acc: 1, vert: 0.8, awr: 1, perD: 1.2, intD: 0.8, reb: 0.8 },
  PF: { inside: 1.5, mid: 1, three: 0.8, reb: 1.4, str: 1.2, vert: 0.8, awr: 1, intD: 1.3, blk: 1 },
  C: { inside: 1.6, reb: 1.6, str: 1.3, awr: 1, intD: 1.5, blk: 1.4, vert: 0.8 },
};

export function overall(p) {
  const w = POS_WEIGHTS[p.pos] || POS_WEIGHTS.SF;
  let s = 0, t = 0;
  for (const k in w) {
    s += (p.ratings ? p.ratings[k] : p.r[k]) * w[k];
    t += w[k];
  }
  return Math.round(s / t);
}

export function cloneTeam(t) {
  return JSON.parse(JSON.stringify(t));
}
