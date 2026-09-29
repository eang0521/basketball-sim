# Hardwood Sim

A 5-on-5 basketball simulation in the browser, built with [Three.js](https://threejs.org/).
Pick two teams and the game plays itself. Each player's ratings drive their decisions,
their movement and the physics of every shot.

**Play it:** https://eang0521.github.io/basketball-sim/

## What's simulated

- **Physics:** the ball is a real projectile. It collides with a torus-shaped rim, the glass
  backboards and the floor. A basket counts only when the ball actually drops through the hoop.
  Players have speed and acceleration limits, jump with gravity, and push each other based on
  strength and size.
- **17 ratings per player:** inside, mid-range, 3-point, free throw, passing, ball handling,
  rebounding, strength, speed, acceleration, vertical, awareness, perimeter D, interior D,
  steal, block and stamina, plus height.
- **Decision making:** the ball handler compares expected points for shooting, driving, passing
  and probing. Awareness controls how cleanly they read the floor. Off-ball players space the
  floor, cut and set pick-and-rolls. Defenders play man-to-man with a reaction lag, help at the
  rim, close out, box out and contest.
- **Full rules:** four 12-minute quarters (adjustable), a 24-second shot clock with a 14-second
  reset on offensive rebounds, shooting and non-shooting fouls, and-ones, the bonus, foul-outs,
  free throws, out-of-bounds and shot-clock violations, jump balls, overtime and timeouts.
  Stamina and fatigue drive substitutions across a 12-player rotation.
- **Calibrated:** over many headless games the sim averages about 114 points, 44% FG, 36% 3P,
  82% FT and about 105 possessions per team, close to modern NBA numbers.

## Controls

- Pause, 1×, 2×, 4× or 8× speed, and **Sim to End**
- Cameras: Broadcast, Follow Ball, Overhead, Baseline and Free Orbit (drag to orbit). Press `C` to cycle.
- Click any player (on court or in the box score) to see their ratings, stamina, stats and what
  they're trying to do right now.
- **Edit roster** on the setup screen changes names, numbers, positions, heights and all ratings.
  Edits are saved in your browser, and teams can be exported and imported as JSON.

## Running locally

It's a static site with no build step. Serve the folder with any static server:

```bash
python -m http.server 8000
```

Then open http://localhost:8000.

To run headless calibration games in Node:

```bash
node tools/simtest.js 10
```

## Project layout

```
js/sim/      simulation (no DOM): game rules, AI, physics, shot model, players
js/render/   Three.js arena, rigged player models + procedural arm IK, cameras
js/ui/       scorebug, box score, play-by-play, inspector, roster editor
js/data/     preset teams
tools/       headless calibration script
```

The player model is the "Xbot" Mixamo character from the three.js examples. Its idle, walk and
run clips are blended by speed. Dribbling, shooting, passing, contesting and rebounding
arm poses are generated on top with two-bone IK.
