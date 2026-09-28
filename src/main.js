import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const TARGET_HEIGHT_PX = 140;
const GROUND_MARGIN_PX = 16; // 창 아래쪽과 발 사이 여백(그림자 자리)
const FACE_CAMERA_DEG = 20; // 진행 방향에서 카메라 쪽으로 더 돌리는 각도
const TURN_SECONDS = 0.4;
const SMILE_RATE = 6; // 초당 보간 비율
const IDLE_OF = { stand: 'Idle', sit: 'SitIdle', lie: 'LieIdle', 'tail-low': 'TailLowIdle', walk: 'Walk', run: 'Run' };

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(devicePixelRatio);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// 직교 카메라, 1 단위 = 1 CSS 픽셀. 원점(발)이 창 아래쪽에서 GROUND_MARGIN_PX 위.
const camera = new THREE.OrthographicCamera(0, 1, 1, 0, -2000, 2000);
let tiltDeg = 12;

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  Object.assign(camera, { left: -w / 2, right: w / 2, top: h - GROUND_MARGIN_PX, bottom: -GROUND_MARGIN_PX });
  camera.rotation.x = -THREE.MathUtils.degToRad(tiltDeg);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// --- 모델 ---
const contract = await (await fetch('model/clips.json')).json();
const clipInfo = Object.fromEntries(contract.clips.map((c) => [c.name, c]));
const gltf = await new GLTFLoader().loadAsync(`model/${contract.model}`);
const bonggu = gltf.scene;
bonggu.animations = gltf.animations;
const box = new THREE.Box3().setFromObject(bonggu);
const size = box.getSize(new THREE.Vector3());
const ppm = TARGET_HEIGHT_PX / size.y; // 1m당 픽셀
bonggu.scale.setScalar(ppm);
bonggu.position.y = -box.min.y * ppm;
scene.add(bonggu);

const smileMeshes = [];
bonggu.traverse((o) => o.morphTargetDictionary?.Smile !== undefined && smileMeshes.push(o));
const setSmile = (v) => smileMeshes.forEach((m) => (m.morphTargetInfluences[m.morphTargetDictionary.Smile] = v));

// 발밑 타원 그림자: 모델의 자식이라 몸 방향을 따라 돈다.
const shadowTex = (() => {
  const c = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const shadow = new THREE.Mesh(
  new THREE.PlaneGeometry(size.x * 1.3, size.z * 1.1),
  new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }),
);
shadow.rotation.x = -Math.PI / 2;
shadow.position.set((box.min.x + box.max.x) / 2, box.min.y + 0.001, (box.min.z + box.max.z) / 2);
shadow.renderOrder = -1;
bonggu.add(shadow);

// --- 애니메이션 ---
const mixer = new THREE.AnimationMixer(bonggu);
const actions = Object.fromEntries(gltf.animations.map((c) => [c.name, mixer.clipAction(c)]));
let current = null;
let smile = 0;
let ui = null;

function play(name) {
  const info = clipInfo[name];
  const next = actions[name].reset();
  next.setLoop(info.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  next.clampWhenFinished = !info.loop;
  if (current && current !== next) next.crossFadeFrom(current, contract.locomotion_blend_seconds, false);
  next.play();
  current = next;
  ui?.show(name);
}
mixer.addEventListener('finished', (e) => play(IDLE_OF[clipInfo[e.action.getClip().name].exit_state]));
play('Idle');

// --- 이동과 방향 ---
let dir = 1; // +1 오른쪽, -1 왼쪽
const facing = (d) => d * THREE.MathUtils.degToRad(90 - FACE_CAMERA_DEG);
const moveFactor = Math.cos(THREE.MathUtils.degToRad(FACE_CAMERA_DEG));
bonggu.rotation.y = facing(dir);

function update(dt) {
  // 크로스페이드 중에는 가중치만큼 섞인 속도로 움직인다.
  // 재생한 적 없는 동작도 가중치가 1로 남아 있어서 재생 중인 것만 센다.
  const mps = Object.values(actions)
    .filter((a) => a.isRunning())
    .reduce((s, a) => s + a.getEffectiveWeight() * clipInfo[a.getClip().name].forward_speed_mps, 0);
  bonggu.position.x += dir * mps * ppm * moveFactor * dt;
  const edge = innerWidth / 2 - TARGET_HEIGHT_PX;
  if (Math.abs(bonggu.position.x) > edge && Math.sign(bonggu.position.x) === dir) dir = -dir; // ponytail: 2단계 확인용, 3단계에서 행동 선택으로 바꾼다

  const target = facing(dir);
  const step = (Math.PI / TURN_SECONDS) * dt;
  bonggu.rotation.y += THREE.MathUtils.clamp(target - bonggu.rotation.y, -step, step);

  const smileTarget = clipInfo[current.getClip().name].smile;
  smile += (smileTarget - smile) * (1 - Math.exp(-SMILE_RATE * dt));
  setSmile(smile);
}

// --- 개발용 패널 (vite dev에서만) ---
if (import.meta.env.DEV) {
  ui = (await import('./dev-panel.js')).mount({
    clips: contract.clips,
    play,
    turn: () => (dir = -dir),
    tilt: tiltDeg,
    setTilt: (v) => ((tiltDeg = v), resize()),
  });
  ui.show(current.getClip().name);
  // 콘솔 디버깅용. tick(dt)은 창이 가려져 프레임이 멈췄을 때 시간을 직접 진행시킨다.
  const tick = (dt) => (mixer.update(dt), update(dt), renderer.render(scene, camera));
  Object.assign(window, { bonggu, actions, camera, tick });
}

const timer = new THREE.Timer();
timer.connect(document);
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), 0.1); // 창이 가려졌다 돌아올 때 순간이동 방지
  mixer.update(dt);
  update(dt);
  renderer.render(scene, camera);
});
