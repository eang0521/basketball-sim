// Camera director: broadcast, ball follow, overhead, baseline and free orbit.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HALF_L } from '../sim/constants.js';

export const CAMERA_MODES = [
  { key: 'broadcast', label: 'Broadcast' },
  { key: 'follow', label: 'Follow Ball' },
  { key: 'overhead', label: 'Overhead' },
  { key: 'baseline', label: 'Baseline' },
  { key: 'free', label: 'Free Orbit' },
];

export class CameraDirector {
  constructor(camera, dom) {
    this.camera = camera;
    this.mode = 'broadcast';
    this.controls = new OrbitControls(camera, dom);
    this.controls.enabled = false;
    this.controls.target.set(0, 1, 0);
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 70;
    this.pos = new THREE.Vector3(0, 11, -24);
    this.look = new THREE.Vector3(0, 1, 0);
    this.camera.position.copy(this.pos);
    this.dir = 1;
  }

  setMode(mode) {
    this.mode = mode;
    this.controls.enabled = mode === 'free';
    if (mode === 'free') {
      this.controls.target.copy(this.look);
      this.controls.update();
    }
  }

  update(dt, game) {
    if (this.mode === 'free') {
      this.controls.update();
      return;
    }
    const b = game.ball;
    if (game.offense != null) this.dir = game.teams[game.offense].dir;
    const bx = THREE.MathUtils.clamp(b.x, -HALF_L, HALF_L);
    const bz = THREE.MathUtils.clamp(b.z, -8, 8);
    const pos = new THREE.Vector3(), look = new THREE.Vector3();
    let fov = 38;
    switch (this.mode) {
      case 'broadcast':
        pos.set(bx * 0.62, 10.5, -23.5);
        look.set(bx * 0.86, 0.6, bz * 0.25);
        break;
      case 'follow': {
        pos.set(bx - this.dir * 8.5, 4.8, bz * 0.6 - 5.5);
        look.set(bx + this.dir * 3, 1.4, bz * 0.8);
        fov = 50;
        break;
      }
      case 'overhead':
        pos.set(bx * 0.35, 34, 0.5);
        look.set(bx * 0.35, 0, 0);
        fov = 45;
        break;
      case 'baseline':
        pos.set(this.dir * (HALF_L + 7.5), 5.2, bz * 0.3);
        look.set(this.dir * 4, 1.2, bz * 0.2);
        fov = 52;
        break;
    }
    const k = 1 - Math.exp(-dt * (this.mode === 'follow' ? 3 : 2.2));
    this.pos.lerp(pos, k);
    this.look.lerp(look, k);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov += (fov - this.camera.fov) * k;
      this.camera.updateProjectionMatrix();
    }
  }
}
