// Rigged player models. The Xbot rig ships with idle/walk/run clips; everything
// basketball-specific (dribbling, shooting, contests, rebounds) is layered on top
// with procedural two-bone arm IK driven by the simulation state.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const MODEL_URL = 'assets/models/Xbot.glb';

export async function loadPlayerAsset(onProgress) {
  const loader = new GLTFLoader();
  try {
    const gltf = await loader.loadAsync(MODEL_URL, (e) => {
      if (onProgress && e.total) onProgress(e.loaded / e.total);
    });
    const clips = {};
    for (const clip of gltf.animations) clips[clip.name] = clip;
    if (clips.sneak_pose) {
      THREE.AnimationUtils.makeClipAdditive(clips.sneak_pose);
      clips.sneak_pose = THREE.AnimationUtils.subclip(clips.sneak_pose, 'sneak_pose', 2, 3, 30);
    }
    const box = new THREE.Box3().setFromObject(gltf.scene);
    return { gltf, clips, height: box.max.y - box.min.y };
  } catch (err) {
    console.warn('Player model failed to load, using fallback figures.', err);
    return null;
  }
}

function numberTexture(num, fg, bg) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 128, 128);
  g.fillStyle = fg;
  g.strokeStyle = bg;
  g.lineWidth = 8;
  g.font = 'bold 84px "Arial Black", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.strokeText(String(num), 64, 68);
  g.fillText(String(num), 64, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function labelSprite(num, color) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.beginPath();
  g.roundRect(14, 8, 100, 48, 14);
  g.fill();
  g.fillStyle = '#fff';
  g.font = 'bold 36px Arial';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(num), 64, 33);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  s.scale.set(0.5, 0.25, 1);
  s.renderOrder = 10;
  return s;
}

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _id = new THREE.Quaternion();

// Rotate `bone` so its child moves from `childPos` toward `target` (world space).
function aimBone(bone, childPos, target, w) {
  bone.getWorldPosition(_v1);
  const cur = _v2.subVectors(childPos, _v1).normalize();
  const des = _v3.subVectors(target, _v1).normalize();
  _q1.setFromUnitVectors(cur, des);
  if (w < 1) _q1.slerpQuaternions(_id, _q1, w);
  bone.getWorldQuaternion(_q2);
  _q2.premultiply(_q1);
  bone.parent.getWorldQuaternion(_q3);
  bone.quaternion.copy(_q3.invert().multiply(_q2));
  bone.updateMatrixWorld(true);
}

const _S = new THREE.Vector3(), _E = new THREE.Vector3(), _H = new THREE.Vector3(), _T = new THREE.Vector3();
const _dir = new THREE.Vector3(), _pole = new THREE.Vector3(), _elbow = new THREE.Vector3();

function solveArm(arm, target, poleHint, w) {
  if (w <= 0.001) return;
  arm.upper.getWorldPosition(_S);
  arm.fore.getWorldPosition(_E);
  arm.hand.getWorldPosition(_H);
  const a = _S.distanceTo(_E), b = _E.distanceTo(_H);
  _T.copy(target);
  _dir.subVectors(_T, _S);
  let d = _dir.length();
  _dir.normalize();
  d = THREE.MathUtils.clamp(d, Math.abs(a - b) + 0.01, (a + b) * 0.999);
  const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  _pole.copy(poleHint).addScaledVector(_dir, -poleHint.dot(_dir)).normalize();
  _elbow.copy(_S).addScaledVector(_dir, a * cosA).addScaledVector(_pole, a * sinA);
  aimBone(arm.upper, _E, _elbow, w);
  arm.fore.getWorldPosition(_E);
  arm.hand.getWorldPosition(_H);
  _T.copy(_S).addScaledVector(_dir, d);
  aimBone(arm.fore, _H, _T, w);
}

const DEFAULT_JOINT = '#222831';

export class PlayerView {
  constructor(scene, player, team, asset, showLabels) {
    this.p = player;
    this.team = team;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.armW = { R: 0, L: 0 };
    this.crouch = 0;
    this.targets = { R: new THREE.Vector3(), L: new THREE.Vector3() };
    this.poles = { R: new THREE.Vector3(), L: new THREE.Vector3() };
    const scale = player.h / (asset ? asset.height : 1.8);
    this.scale = scale;

    if (asset) {
      const model = SkeletonUtils.clone(asset.gltf.scene);
      const body = new THREE.MeshStandardMaterial({ color: team.primary, roughness: 0.55, metalness: 0.1 });
      const joints = new THREE.MeshStandardMaterial({ color: team.secondary || DEFAULT_JOINT, roughness: 0.5, metalness: 0.3 });
      model.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.frustumCulled = false;
          const n = (o.material && o.material.name) || '';
          o.material = n.includes('Joints') ? joints : body;
        }
      });
      this.materials = [body, joints];
      this.model = model;
      this.bones = {};
      model.traverse((o) => { if (o.isBone) this.bones[o.name.replace('mixamorig:', '').replace('mixamorig', '')] = o; });
      this.arms = {
        R: { upper: this.bones.RightArm, fore: this.bones.RightForeArm, hand: this.bones.RightHand, shoulder: this.bones.RightShoulder },
        L: { upper: this.bones.LeftArm, fore: this.bones.LeftForeArm, hand: this.bones.LeftHand, shoulder: this.bones.LeftShoulder },
      };
      // Jersey numbers glued to the chest bone.
      model.updateMatrixWorld(true);
      const spine = this.bones.Spine2;
      if (spine) {
        const tex = numberTexture(player.num, team.secondary || '#fff', team.primary);
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
        const sp = new THREE.Vector3();
        spine.getWorldPosition(sp);
        const front = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26), mat);
        front.position.set(sp.x, sp.y - 0.02, sp.z + 0.155);
        model.add(front);
        spine.attach(front);
        const back = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), mat);
        back.position.set(sp.x, sp.y + 0.02, sp.z - 0.16);
        back.rotation.y = Math.PI;
        model.add(back);
        spine.attach(back);
      }
      model.scale.setScalar(scale);
      this.root.add(model);

      this.mixer = new THREE.AnimationMixer(model);
      const c = asset.clips;
      this.idle = this.mixer.clipAction(c.idle);
      this.walk = this.mixer.clipAction(c.walk);
      this.run = this.mixer.clipAction(c.run);
      for (const a of [this.idle, this.walk, this.run]) { a.play(); a.setEffectiveWeight(0); }
      this.idle.setEffectiveWeight(1);
      if (c.sneak_pose) {
        this.sneak = this.mixer.clipAction(c.sneak_pose);
        this.sneak.blendMode = THREE.AdditiveAnimationBlendMode;
        this.sneak.play();
        this.sneak.setEffectiveWeight(0);
      }
      this.mixer.update(Math.random() * 2);
    } else {
      // Fallback figure: capsule body + head.
      const mat = new THREE.MeshStandardMaterial({ color: team.primary, roughness: 0.6 });
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, player.h - 0.75, 4, 10), mat);
      body.position.y = (player.h - 0.26) / 2 + 0.02;
      body.castShadow = true;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), new THREE.MeshStandardMaterial({ color: team.secondary }));
      head.position.y = player.h - 0.13;
      head.castShadow = true;
      this.root.add(body, head);
      this.materials = [mat];
    }

    // Invisible hitbox for picking, selection ring, number label.
    this.hit = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, player.h, 8), new THREE.MeshBasicMaterial({ visible: false }));
    this.hit.position.y = player.h / 2;
    this.hit.userData.playerId = player.id;
    this.root.add(this.hit);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 32), new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.9, depthWrite: false }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.015;
    this.ring.visible = false;
    this.root.add(this.ring);
    this.label = labelSprite(player.num, team.primary);
    this.label.position.y = player.h + 0.35;
    this.labelsOn = showLabels;
    this.label.visible = showLabels;
    this.root.add(this.label);
  }

  setSelected(v) { this.ring.visible = v; }
  setLabels(v) { this.labelsOn = v; this.label.visible = v && this.p.onCourt; }

  update(dt, game, simDt) {
    const p = this.p;
    this.root.position.set(p.x, p.y, p.z);
    this.root.rotation.y = p.facing;
    this.label.visible = this.labelsOn && p.onCourt;
    if (!this.mixer) return;

    // Locomotion blend from actual speed.
    const s = p.speed;
    const idleW = THREE.MathUtils.clamp(1 - s / 1.1, 0, 1);
    const runW = THREE.MathUtils.clamp((s - 1.9) / 1.8, 0, 1);
    const walkW = Math.max(0, 1 - idleW - runW);
    this.idle.setEffectiveWeight(idleW);
    this.walk.setEffectiveWeight(walkW);
    this.run.setEffectiveWeight(runW);
    this.walk.timeScale = THREE.MathUtils.clamp(s / 1.5, 0.6, 1.6);
    this.run.timeScale = THREE.MathUtils.clamp(s / 5.2, 0.7, 1.5);
    const defending = p.onCourt && (p.pose === 'defend' || p.pose === 'boxout') && !p.airborne;
    this.crouch += ((defending ? 0.75 : 0) - this.crouch) * Math.min(1, dt * 6);
    if (this.sneak) this.sneak.setEffectiveWeight(this.crouch);
    this.mixer.update(simDt);
    this.root.updateMatrixWorld(true);
    this.applyArms(dt, game);
  }

  applyArms(dt, game) {
    const p = this.p;
    const ball = game.ball;
    const f = _v4.set(Math.sin(p.facing), 0, Math.cos(p.facing));
    const fx = f.x, fz = f.z;
    const rx = -Math.cos(p.facing), rz = Math.sin(p.facing);
    const up = p.h;
    let wantR = 0, wantL = 0;
    const tR = this.targets.R, tL = this.targets.L;
    const shR = new THREE.Vector3(), shL = new THREE.Vector3();
    this.arms.R.upper.getWorldPosition(shR);
    this.arms.L.upper.getWorldPosition(shL);
    // Default elbow poles: down, out and slightly back.
    this.poles.R.set(rx * 0.6 - fx * 0.4, -1, rz * 0.6 - fz * 0.4);
    this.poles.L.set(-rx * 0.6 - fx * 0.4, -1, -rz * 0.6 - fz * 0.4);
    const holding = ball.holder === p && ball.state === 'held';
    const act = p.action;
    const shooting = act && act.type === 'shoot';

    if (p.onCourt && shooting) {
      if (holding) {
        tR.set(ball.x - fx * 0.08, ball.y - 0.1, ball.z - fz * 0.08);
        tL.set(ball.x + rx * 0.13, ball.y, ball.z + rz * 0.13);
        wantR = wantL = 1;
      } else if (act.kind === 'dunk') {
        tR.set(shR.x + fx * 0.45, shR.y + 0.35, shR.z + fz * 0.45);
        tL.set(shL.x + fx * 0.45, shL.y + 0.35, shL.z + fz * 0.45);
        wantR = wantL = 1;
      } else {
        // follow-through
        tR.set(shR.x + fx * 0.4, shR.y + 0.55, shR.z + fz * 0.4);
        tL.set(shL.x + fx * 0.3, shL.y + 0.45, shL.z + fz * 0.3);
        wantR = 1; wantL = 0.8;
      }
      this.poles.R.set(rx * 0.5 + fx * 0.2, -1, rz * 0.5 + fz * 0.2);
      this.poles.L.set(-rx * 0.5 + fx * 0.2, -1, -rz * 0.5 + fz * 0.2);
    } else if (p.onCourt && holding && p.dribbling) {
      tR.set(ball.x, Math.max(ball.y + 0.13, up * 0.42), ball.z);
      wantR = 1;
      // off-arm up to protect the ball
      tL.set(shL.x + fx * 0.35 - rx * 0.1, shL.y - 0.3, shL.z + fz * 0.35 - rz * 0.1);
      wantL = 0.5;
    } else if (p.onCourt && holding) {
      tR.set(ball.x - rx * 0.13, ball.y, ball.z - rz * 0.13);
      tL.set(ball.x + rx * 0.13, ball.y, ball.z + rz * 0.13);
      wantR = wantL = 1;
    } else if (p.onCourt && (p.pose === 'contest' || p.pose === 'block' || (p.airborne && p.pose === 'rebound'))) {
      tR.set(shR.x + fx * 0.15, shR.y + 0.7, shR.z + fz * 0.15);
      tL.set(shL.x + fx * 0.15, shL.y + 0.7, shL.z + fz * 0.15);
      wantR = 1; wantL = p.pose === 'contest' ? 0.6 : 1;
      this.poles.R.set(rx, 0, rz); this.poles.L.set(-rx, 0, -rz);
    } else if (p.onCourt && p.pose === 'catch') {
      tR.set(shR.x + fx * 0.5, shR.y - 0.05, shR.z + fz * 0.5);
      tL.set(shL.x + fx * 0.5, shL.y - 0.05, shL.z + fz * 0.5);
      wantR = wantL = 0.85;
    } else if (p.onCourt && p.pose === 'boxout') {
      tR.set(shR.x + rx * 0.5 - fx * 0.1, shR.y - 0.1, shR.z + rz * 0.5 - fz * 0.1);
      tL.set(shL.x - rx * 0.5 - fx * 0.1, shL.y - 0.1, shL.z - rz * 0.5 - fz * 0.1);
      wantR = wantL = 0.9;
    } else if (p.onCourt && p.pose === 'defend' && p.speed < 3.5) {
      const onBall = ball.holder && p.man === ball.holder;
      tR.set(shR.x + rx * 0.4 + fx * 0.3, shR.y + (onBall ? 0.05 : -0.2), shR.z + rz * 0.4 + fz * 0.3);
      tL.set(shL.x - rx * 0.4 + fx * 0.3, shL.y + (onBall ? -0.15 : -0.25), shL.z - rz * 0.4 + fz * 0.3);
      wantR = wantL = 0.8;
    }
    const k = Math.min(1, dt * 12);
    this.armW.R += (wantR - this.armW.R) * k;
    this.armW.L += (wantL - this.armW.L) * k;
    if (this.armW.R > 0.01) solveArm(this.arms.R, tR, this.poles.R, this.armW.R);
    if (this.armW.L > 0.01) solveArm(this.arms.L, tL, this.poles.L, this.armW.L);
  }

  dispose(scene) {
    scene.remove(this.root);
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.map) o.material.map.dispose();
    });
    for (const m of this.materials) m.dispose();
  }
}

export class BallView {
  constructor(scene) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#d4611c';
    g.fillRect(0, 0, 256, 128);
    // pebbled texture
    for (let i = 0; i < 2500; i++) {
      g.fillStyle = `rgba(0,0,0,${Math.random() * 0.08})`;
      g.fillRect(Math.random() * 256, Math.random() * 128, 1.5, 1.5);
    }
    g.strokeStyle = '#1a0d05';
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(0, 64); g.lineTo(256, 64); g.stroke();
    for (const x of [64, 192]) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke(); }
    for (const x of [0, 128, 256]) {
      g.beginPath();
      g.ellipse(x, 64, 30, 64, 0, 0, Math.PI * 2);
      g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 16), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }));
    this.mesh.castShadow = true;
    scene.add(this.mesh);
    this.axis = new THREE.Vector3(1, 0, 0);
  }

  update(dt, game) {
    const b = game.ball;
    this.mesh.position.set(b.x, b.y, b.z);
    this.mesh.visible = !(b.state === 'dead' && game.phase === 'periodEnd');
    const sp = Math.hypot(b.vx, b.vz);
    if (b.state === 'air' && sp > 0.2) {
      // Backspin on shots, rolling spin otherwise.
      this.axis.set(b.vz, 0, -b.vx).normalize();
      this.mesh.rotateOnWorldAxis(this.axis, (b.shot ? -1 : 1) * sp * dt * 6);
    } else if (b.state === 'held' && b.holder && b.holder.dribbling) {
      this.mesh.rotateX(dt * 8);
    }
  }
}
