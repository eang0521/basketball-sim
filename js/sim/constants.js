// All units are meters and seconds. The court is centered at the origin:
// x runs along the length of the court, z along the width, y is up.

export const HALF_L = 14.325; // 94 ft court
export const HALF_W = 7.62; // 50 ft court
export const RIM_Y = 3.048;
export const RIM_R = 0.2286;
export const RIM_TUBE = 0.011;
export const RIM_FROM_BASE = 1.575;
export const RIM_X = HALF_L - RIM_FROM_BASE; // |x| of each rim center
export const BOARD_FROM_RIM = 0.375; // backboard face distance behind rim center
export const BOARD_HALF_W = 0.915;
export const BOARD_BOTTOM = 2.9;
export const BOARD_TOP = 3.97;
export const BALL_R = 0.12;
export const G = 9.81;

export const THREE_R = 7.24;
export const CORNER3_Z = 6.71;
export const CORNER3_U = 4.27; // corner straightaway length measured from baseline
export const LANE_HALF_W = 2.44;
export const FT_U = 5.8; // free-throw line distance from baseline
export const PLAYER_R = 0.36;

export const SHOT_CLOCK = 24;
export const OREB_CLOCK = 14;
export const POS_ORDER = ['PG', 'SG', 'SF', 'PF', 'C'];

export const RATING_KEYS = [
  'inside', 'mid', 'three', 'ft', 'pass', 'handle', 'reb', 'str', 'spd', 'acc',
  'vert', 'awr', 'perD', 'intD', 'stl', 'blk', 'sta',
];

export const RATING_LABELS = {
  inside: 'Inside Shot', mid: 'Mid-Range', three: '3-Point', ft: 'Free Throw',
  pass: 'Passing', handle: 'Ball Handling', reb: 'Rebounding', str: 'Strength',
  spd: 'Speed', acc: 'Acceleration', vert: 'Vertical', awr: 'Awareness',
  perD: 'Perimeter D', intD: 'Interior D', stl: 'Steal', blk: 'Block', sta: 'Stamina',
};

export const RATING_SHORT = {
  inside: 'INS', mid: 'MID', three: '3PT', ft: 'FT', pass: 'PAS', handle: 'HDL', reb: 'REB',
  str: 'STR', spd: 'SPD', acc: 'ACC', vert: 'VRT', awr: 'AWR', perD: 'PRD', intD: 'IND',
  stl: 'STL', blk: 'BLK', sta: 'STA',
};

export function rimX(dir) {
  return dir * RIM_X;
}

// Convert attack-relative coords (u = distance from attacking baseline, v = lateral)
// into court coordinates for a team attacking toward `dir` (+1 / -1).
export function toCourt(dir, u, v) {
  return { x: dir * (HALF_L - u), z: v * dir };
}

export function uOf(dir, x) {
  return HALF_L - dir * x;
}

export function isThree(dir, x, z) {
  const u = uOf(dir, x);
  if (u <= CORNER3_U) return Math.abs(z) > CORNER3_Z;
  return Math.hypot(x - rimX(dir), z) > THREE_R;
}

export function inBounds(x, z, margin = 0) {
  return Math.abs(x) <= HALF_L - margin && Math.abs(z) <= HALF_W - margin;
}
