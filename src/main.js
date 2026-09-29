import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { isTauri } from '@tauri-apps/api/core';
import { createBrain } from './behavior.js';
import { hitsModel } from './picking.js';

const TARGET_HEIGHT_PX = 140;
const GROUND_MARGIN_PX = 24; // 창 아래쪽과 발 사이 여백(그림자 자리, 카메라 쪽으로 돌 때 앞으로 나올 자리)
const FACE_CAMERA_DEG = 20; // 진행 방향에서 카메라 쪽으로 더 돌리는 각도
const TURN_RADIUS = 0.25; // 돌아설 때 그리는 호의 반지름(봉구 키 대비)
const TURN_MIN_SPEED_PX = 25; // 걸음이 멈춰도 이 속도로는 마저 돈다
const DEPTH_RETURN = 0.1; // 돌고 나서 밀린 앞뒤 위치를 걸음 속도의 이 비율로 원래 줄로 되돌린다
const SMILE_RATE = 6; // 초당 보간 비율
const GRAB_PX = 5; // 누른 채 이만큼 움직이면 쓰다듬기가 아니라 들어 올리기
const FOLLOW_RATE = 25; // 들려 있을 때 커서를 따라가는 초당 보간 비율(살짝 늦게 따라와 매달린 느낌)
const YAW_RATE = 8; // 들 때 정면으로, 놓을 때 진행 방향으로 몸을 돌리는 초당 보간 비율
const IDLE_OF = {
  stand: 'Idle', sit: 'SitIdle', lie: 'LieIdle', 'tail-low': 'TailLowIdle', walk: 'Walk', run: 'Run',
  sleep: 'SleepIdle', held: 'Dangle',
};

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(devicePixelRatio);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// 직교 카메라, 1 단위 = 1 CSS 픽셀. 원점(발)이 창 아래쪽에서 GROUND_MARGIN_PX 위.
const camera = new THREE.OrthographicCamera(0, 1, 1, 0, -2000, 2000);
let tiltDeg = 20;
// 데스크톱 창은 작업 영역 높이로 떠 있지만 평소에는 바닥 띠만 그린다. 들고 있는 동안만 창 전체를 그린다.
// 창 크기를 바꾸면 웹뷰가 다시 그리기 전 화면이 잠깐 보여 깜빡이므로, 캔버스 크기만 바꾼다.
const STRIP_PX = isTauri() ? 300 : 0; // 0이면 늘 창 전체(브라우저)
let tall = false;

function resize() {
  const w = innerWidth, h = STRIP_PX && !tall ? Math.min(STRIP_PX, innerHeight) : innerHeight;
  renderer.setPixelRatio(devicePixelRatio); // 배율이 다른 모니터로 옮기면 바뀐다
  renderer.setSize(w, h);
  Object.assign(camera, { left: -w / 2, right: w / 2, top: h - GROUND_MARGIN_PX, bottom: -GROUND_MARGIN_PX });
  camera.rotation.x = -THREE.MathUtils.degToRad(tiltDeg);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
// 캔버스 크기를 바꾸면 지워지므로 같은 프레임에 바로 다시 그린다.
function setTall(on) {
  tall = on;
  resize();
  renderer.render(scene, camera);
}

// --- 모델 ---
const contract = await (await fetch('model/clips.json')).json();
const clipInfo = Object.fromEntries(contract.clips.map((c) => [c.name, c]));
const gltf = await new GLTFLoader().loadAsync(`model/${contract.model}`);
const bonggu = gltf.scene;
bonggu.animations = gltf.animations;
const box = new THREE.Box3().setFromObject(bonggu);
const size = box.getSize(new THREE.Vector3());
let ppm; // 1m당 픽셀
let heightPx;
let groundY; // 서 있을 때 모델 원점 높이
function setHeight(px) {
  heightPx = px;
  ppm = px / size.y;
  bonggu.scale.setScalar(ppm);
  bonggu.position.y = groundY = -box.min.y * ppm;
}
setHeight(TARGET_HEIGHT_PX);
scene.add(bonggu);
// 더 좁은 모니터로 옮겨지면 화면 안으로 들인다.
addEventListener('resize', () => {
  const limit = Math.max(0, innerWidth / 2 - heightPx);
  bonggu.position.x = THREE.MathUtils.clamp(bonggu.position.x, -limit, limit);
});

const morphMeshes = [];
bonggu.traverse((o) => o.morphTargetDictionary && morphMeshes.push(o));
const setMorph = (name, v) =>
  morphMeshes.forEach((m) => m.morphTargetDictionary[name] !== undefined && (m.morphTargetInfluences[m.morphTargetDictionary[name]] = v));
// 하품·눈 감기처럼 clips.json에 [초, 값] 곡선(morphs)으로 주어진 표정들
const curveNames = [...new Set(contract.clips.flatMap((c) => Object.keys(c.morphs ?? {})))];
function sample(curve, t) {
  const i = curve.findIndex(([ct]) => ct >= t);
  if (i < 0) return curve.at(-1)[1];
  if (i === 0) return curve[0][1];
  const [t0, v0] = curve[i - 1], [t1, v1] = curve[i];
  return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}

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

function play(name, timeScale = 1) {
  const info = clipInfo[name];
  const next = actions[name];
  next.timeScale = timeScale;
  if (next === current && info.loop) return; // 이미 도는 루프를 처음으로 되감지 않는다
  next.reset();
  next.setLoop(info.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  next.clampWhenFinished = !info.loop;
  if (current && current !== next) next.crossFadeFrom(current, contract.locomotion_blend_seconds, false);
  next.play();
  current = next;
  ui?.show(name);
}
// 이미 다른 클립으로 넘어간 뒤(예: 앉는 도중 들어 올림) 페이드아웃 중에 끝난 클립은 무시한다.
mixer.addEventListener('finished', (e) => e.action === current && play(IDLE_OF[clipInfo[e.action.getClip().name].exit_state]));
play('Idle');

// --- 이동과 방향 ---
let dir = 1; // +1 오른쪽, -1 왼쪽
let speedPx = 0; // 현재 화면 이동 속도(px/s)
let turnLeft = 0; // 남은 회전각(rad). 0이 아니면 U자를 그리며 도는 중
const facing = (d) => d * THREE.MathUtils.degToRad(90 - FACE_CAMERA_DEG);
const moveFactor = Math.cos(THREE.MathUtils.degToRad(FACE_CAMERA_DEG));
bonggu.rotation.y = facing(dir);

// 제자리에서 돌지 않고 걸으면서 U자로 돈다. U자는 좌우 대칭이라 x는 제자리지만 앞뒤(z)로 밀린다.
// 카메라 쪽(얼굴이 보임, 앞으로 밀림)과 뒤쪽(엉덩이가 보임, 뒤로 밀림) 중 둘 다 되면 반반으로 고른다.
// 앞으로 너무 나오면 발이 창 아래로 잘리고, 뒤로 너무 가면 떠 보인다.
function face(d) {
  if (d === dir) return;
  dir = d;
  const viaFront = facing(d) - bonggu.rotation.y; // 카메라 쪽으로 도는 각
  const depth = 2 * Math.sin(facing(1)) * TURN_RADIUS * heightPx; // U자 한 번에 앞뒤로 밀리는 거리
  const z = bonggu.position.z;
  const frontOk = (z + depth) * Math.sin(THREE.MathUtils.degToRad(tiltDeg)) <= GROUND_MARGIN_PX - 8;
  const backOk = z - depth >= -2 * depth;
  turnLeft = frontOk && (!backOk || Math.random() < 0.5) ? viaFront : viaFront - Math.sign(viaFront) * 2 * Math.PI;
}

// --- 들어 올리기 ---
// 드래그하면 Dangle의 grip_point(겨드랑이)가 커서를 따라가고, 놓으면 떨어져 착지한 뒤 선다.
const GRAVITY = 9.8; // m/s²
const grip = new THREE.Vector3(...clipInfo[IDLE_OF.held].grip_point);
let holdTarget = null; // 들고 있는 동안 grip이 갈 월드 좌표
let fallSpeed = null; // 놓은 뒤 떨어지는 속도(px/s). null이면 떨어지는 중이 아니다

function grab() {
  holdTarget = new THREE.Vector3();
  fallSpeed = null;
  turnLeft = 0;
  bonggu.rotation.y = Math.atan2(Math.sin(bonggu.rotation.y), Math.cos(bonggu.rotation.y)); // U자 도중이면 각을 접는다
  brain.hold();
  play(IDLE_OF.held);
  setTall(true);
  desktop?.hold(true);
}

function update(dt) {
  // 크로스페이드 중에는 가중치만큼 섞인 속도로 움직이고 표정도 섞는다. timeScale을 흔들면 속도도 같은 비율로.
  // 재생한 적 없는 동작도 가중치가 1로 남아 있어서 믹서에 올라간 것만 센다(끝나서 멈춘 채 페이드아웃 중인 한 번 재생 클립 포함).
  const active = Object.values(actions).filter((a) => a.isScheduled());
  const mps = active.reduce((s, a) => s + a.getEffectiveWeight() * a.getEffectiveTimeScale() * clipInfo[a.getClip().name].forward_speed_mps, 0);
  for (const name of curveNames) {
    setMorph(name, active.reduce((s, a) => {
      const curve = clipInfo[a.getClip().name].morphs?.[name];
      return curve ? s + a.getEffectiveWeight() * sample(curve, a.time) : s;
    }, 0));
  }
  const pathPx = mps * ppm; // 발이 딛는 방향으로의 속도
  speedPx = pathPx * moveFactor;

  if (!turnLeft) {
    // 들고 있으면 얼굴이 정면(카메라)을 보고, 놓으면 떨어지면서 원래 진행 방향으로 돌아간다.
    const yaw = holdTarget ? 0 : facing(dir);
    bonggu.rotation.y += (yaw - bonggu.rotation.y) * (1 - Math.exp(-YAW_RATE * dt));
  }

  if (holdTarget) {
    const to = holdTarget.clone().sub(grip.clone().multiplyScalar(ppm).applyQuaternion(bonggu.quaternion));
    to.y = Math.max(to.y, groundY); // 커서를 바닥 가까이 내려도 땅속으로 파고들지 않는다
    bonggu.position.lerp(to, 1 - Math.exp(-FOLLOW_RATE * dt));
  } else if (fallSpeed !== null) {
    fallSpeed += GRAVITY * ppm * dt;
    bonggu.position.y -= fallSpeed * dt;
    if (bonggu.position.y <= groundY) {
      bonggu.position.y = groundY;
      fallSpeed = null;
      play(IDLE_OF.stand);
      setTall(false);
      desktop?.hold(false);
    }
  } else if (turnLeft) {
    // 각속도 = 속도 / 반지름이라 걸음과 회전이 맞고, 걸음이 붙고 빠지는 동안 회전도 부드럽게 붙고 빠진다.
    const w = Math.max(pathPx, TURN_MIN_SPEED_PX) / (TURN_RADIUS * heightPx);
    const da = Math.sign(turnLeft) * Math.min(Math.abs(turnLeft), w * dt);
    bonggu.rotation.y += da;
    turnLeft -= da;
    bonggu.position.x += Math.sin(bonggu.rotation.y) * pathPx * dt;
    bonggu.position.z += Math.cos(bonggu.rotation.y) * pathPx * dt;
    if (!turnLeft) bonggu.rotation.y = facing(dir);
  } else {
    const z = bonggu.position.z;
    bonggu.position.x += dir * speedPx * dt;
    bonggu.position.z -= Math.sign(z) * Math.min(Math.abs(z), DEPTH_RETURN * pathPx * dt);
  }

  shadow.position.y = box.min.y + 0.001 + (groundY - bonggu.position.y) / ppm; // 들려 있어도 그림자는 바닥에

  const smileTarget = clipInfo[current.getClip().name].smile;
  smile += (smileTarget - smile) * (1 - Math.exp(-SMILE_RATE * dt));
  setMorph('Smile', smile);
}

// --- 행동 ---
// 마지막 입력 뒤로 지난 초. 데스크톱이면 시스템 전체(desktop.js), 브라우저면 이 페이지의 입력만 센다.
let lastInput = performance.now();
for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel']) addEventListener(type, () => (lastInput = performance.now()));

const body = {
  clips: contract.clips,
  blendSeconds: contract.locomotion_blend_seconds,
  clipSeconds: (name) => clipInfo[name].duration_seconds,
  play,
  face,
  get dir() { return dir; },
  get turned() { return turnLeft === 0; },
  get held() { return holdTarget !== null || fallSpeed !== null; },
  get idle() { return desktop ? desktop.idle : (performance.now() - lastInput) / 1000; },
  get x() { return bonggu.position.x; },
  get speed() { return speedPx; },
  get halfWidth() { return innerWidth / 2; },
  get clip() { return current.getClip().name; },
  get clipLoops() { return clipInfo[this.clip].loop; },
  get state() { return clipInfo[this.clip].exit_state; },
};
const brain = createBrain(body, { log: import.meta.env.DEV ? (m) => console.info(`[봉구] ${m}`) : undefined });
brain.start();

// 봉구를 클릭하면 쓰다듬기, 누른 채 끌면 들어 올리기. 그림자는 제외한다.
const raycaster = new THREE.Raycaster();
const canvas = renderer.domElement;
function aim(e) {
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  // 직교 카메라 광선은 절두체 가운데(카메라 평면)에서 시작해 기울어진 카메라 앞쪽이 빠진다. near 평면에서 시작한다.
  raycaster.ray.origin.set(ndc.x, ndc.y, -1).unproject(camera);
  return raycaster.ray;
}
let press = null; // 봉구 위에서 누른 위치
canvas.addEventListener('pointerdown', (e) => {
  aim(e);
  if (e.button !== 0 || !hitsModel(raycaster, bonggu, shadow)) return;
  press = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId); // 커서가 창 밖으로 나가도 계속 받는다
});
canvas.addEventListener('pointermove', (e) => {
  if (!press) return;
  if (!holdTarget) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < GRAB_PX) return;
    grab();
  }
  aim(e).intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -bonggu.position.z), holdTarget);
});
function release(pet) {
  if (!press) return;
  press = null;
  if (!holdTarget) return pet && brain.pet();
  holdTarget = null;
  fallSpeed = 0;
}
canvas.addEventListener('pointerup', () => release(true));
canvas.addEventListener('pointercancel', () => release(false));

// Tauri 창이면 봉구 밖 클릭 통과와 트레이 크기 메뉴를 붙인다.
const desktop = isTauri() ? await (await import('./desktop.js')).attach({ renderer, setHeight }) : null;

function step(dt) {
  mixer.update(dt);
  update(dt);
  brain.tick(dt);
  renderer.render(scene, camera);
  desktop?.afterRender();
}

// --- 개발용 패널 (브라우저 vite dev에서만) ---
if (import.meta.env.DEV && !desktop) {
  ui = (await import('./dev-panel.js')).mount({
    clips: contract.clips,
    play: (name) => (brain.stop(), play(name)),
    turn: () => face(-dir),
    brain,
    tilt: tiltDeg,
    setTilt: (v) => ((tiltDeg = v), resize()),
  });
  ui.show(current.getClip().name);
  // 콘솔 디버깅용. tick(초)은 창이 가려져 프레임이 멈췄을 때 시간을 직접 진행시킨다.
  // 프레임마다 마이크로태스크를 양보해야 행동 선택의 await가 이어진다.
  const tick = async (seconds) => {
    for (let t = 0; t < seconds; t += 1 / 30) {
      step(1 / 30);
      for (let i = 0; i < 8; i++) await null;
    }
  };
  Object.assign(window, { bonggu, brain, body, tick, camera, THREE });
}

// ?speed=5 처럼 시간 배속. 긴 흐름을 빨리 확인할 때 쓴다.
const simSpeed = Number(new URLSearchParams(location.search).get('speed')) || 1;
// 클립이 30fps로 만들어져 있어서 그 이상 그리지 않는다. 하루 종일 켜 두는 앱이라 CPU를 아낀다.
const MAX_FPS = 30;
const timer = new THREE.Timer();
timer.connect(document);
let pending = 0;
renderer.setAnimationLoop((time) => {
  timer.update(time);
  pending += timer.getDelta();
  if (pending < 1 / MAX_FPS - 0.004) return; // 모니터 주사율 오차 여유
  step(Math.min(pending, 0.1) * simSpeed); // 창이 가려졌다 돌아올 때 순간이동 방지
  pending = 0;
});
