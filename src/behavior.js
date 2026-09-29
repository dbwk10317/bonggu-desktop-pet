// 봉구의 행동 선택. 목표는 기계처럼 보이지 않는 자연스러움이다(PLAN.md "행동 선택").
// 조정값은 모두 T에 모아 두고 지켜보며 고친다.
const T = {
  standWait: [1.5, 6], // 행동 사이에 서서 쉬는 시간(초)
  sit: [10, 40],
  lie: [20, 90],
  tailLow: [8, 20],
  strollPx: [200, 1000], // 한 번 걷는 거리(화면 안쪽으로 잘린다)
  strollMore: 0.35, // 도착한 뒤 다른 곳으로 이어 걸을 확률
  runSeconds: [1, 3],
  walkAfterRun: [0.6, 1.5],
  edgeMarginPx: 180, // 목적지는 화면 가장자리에서 이만큼 안쪽에서만 고른다
  gaitJitter: 0.1, // 걷기·달리기 timeScale ±10%
  turnGait: 0.8, // 돌아설 때 걸음 빠르기(보통 걷기 대비)
  repeatPenalty: 0.15, // 방금 한 행동의 가중치 배율
  repeatRecover: 0.3, // 행동을 고를 때마다 회복되는 배율
  sleepAfterIdle: 300, // 마우스·키보드 입력이 이만큼(초) 없으면 엎드려 잠든다
  wakeDelay: 5, // 잠든 뒤 입력이 생기면 이만큼(초) 뒤에 깬다
  energyStart: 0.7,
  // 기운 변화(초당). 아무것도 안 해도 조금씩 졸려서 10–15분 활동하면 길게 엎드려 쉰다.
  energyDrift: -0.0008,
  energyPerSec: { Walk: -0.006, Run: -0.03, PlayBow: -0.02, sit: 0.005, lie: 0.009, 'tail-low': 0.002, sleep: 0.015 },
  energyPet: 0.1,
};

// 기운(e, 0–1)에 따른 가중치. 높으면 움직이고 낮으면 쉰다.
const WEIGHTS = {
  stroll: (e) => 4 * (0.4 + e),
  run: (e) => (e > 0.5 ? 3 * (e - 0.5) : 0),
  sniff: () => 0.9,
  lookAround: () => 1,
  lookUp: () => 0.5,
  wagSoft: () => 0.6,
  playBow: (e) => 0.8 * e,
  sit: (e) => 1.5 * (1.1 - e),
  lie: (e) => 2 * (1 - e) ** 2,
  tailLow: () => 0.25,
  yawn: (e) => 0.5 * (1.2 - e), // 피곤할수록 자주
};

// FallAsleep은 오른쪽 옆구리를 대고 눕는다. 왼쪽을 보고 누워야 얼굴과 배가 카메라 쪽으로 보인다.
const SLEEP_DIR = -1;

const skew =([a, b]) => a + (b - a) * Math.random() ** 2; // 짧은 쪽이 흔하고 가끔 길게
const reps = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const chance = (p) => Math.random() < p;
const CANCEL = Symbol('cancel');

export function createBrain(body, { log = () => {} } = {}) {
  let time = 0;
  let energy = T.energyStart;
  let running = false;
  let generation = 0;
  let petting = false;
  let sleeping = false;
  const penalty = {};
  const waiters = new Set();

  const until = (pred) => new Promise((resolve, reject) => waiters.add({ pred, resolve, reject }));
  const sleep = (s) => { const end = time + s; return until(() => time >= end); };
  function interrupt() {
    for (const w of waiters) w.reject(CANCEL);
    waiters.clear();
  }

  // --- 동작 단위 ---
  const jitter = () => 1 + (Math.random() * 2 - 1) * T.gaitJitter;
  const limit = () => Math.max(0, body.halfWidth - Math.min(T.edgeMarginPx, body.halfWidth * 0.3));
  const room = (d) => limit() - d * body.x; // d 방향으로 남은 거리

  async function oneShot(name) {
    body.play(name);
    await until(() => body.clip !== name); // 끝나면 main.js가 exit_state 대기 루프로 넘긴다
  }
  async function loop(name, n) {
    body.play(name);
    await sleep(n * body.clipSeconds(name));
    body.play('Idle');
  }
  async function halt() {
    if (body.state === 'walk' || body.state === 'run') body.play('Idle');
    await until(() => body.speed < 1);
  }
  async function standUp() {
    await until(() => body.clipLoops); // 앉는 중이면 다 앉은 뒤에
    await halt();
    const up = body.state !== 'stand' && body.clips.find((c) => !c.loop && c.entry_state === body.state && c.exit_state === 'stand');
    if (up) await oneShot(up.name);
  }
  async function turn(d) {
    if (d === body.dir) return;
    if (chance(0.25)) await loop('LookAround', 1);
    body.play('Walk', T.turnGait * jitter()); // 걸으면서 U자로 돈다(main.js face)
    body.face(d);
    await until(() => body.turned);
  }
  async function walkTo(x) {
    // 창이 줄거나 냄새 맡은 뒤 다음 구간으로 출발할 때도 현재 화면 안을 목표로 한다.
    const target = () => Math.max(-limit(), Math.min(limit(), x));
    const d = Math.sign(target() - body.x);
    if (!d) return;
    await turn(d);
    body.play('Walk', jitter());
    await until(() => (target() - body.x) * d <= (body.speed * body.blendSeconds) / 2);
    await halt();
  }

  // --- 행동 흐름 ---
  function strollTarget() {
    let d = chance(0.65) ? body.dir : -body.dir;
    if (room(d) < 80) d = -d;
    return body.x + d * Math.min(skew(T.strollPx), room(d));
  }
  async function stroll() {
    do {
      const target = strollTarget();
      if (chance(0.3)) {
        await walkTo(body.x + (target - body.x) * (0.3 + Math.random() * 0.4));
        await (chance(0.6) ? loop('GroundSniff', 1) : sleep(skew([1, 3])));
      }
      await walkTo(target);
      if (chance(0.3)) await loop('GroundSniff', 1);
      else await sleep(skew([0.5, 2]));
    } while (chance(T.strollMore));
  }
  async function runBurst() {
    const d = room(1) > room(-1) ? 1 : -1;
    await turn(d);
    body.play('Run', jitter());
    const runEnd = time + skew(T.runSeconds);
    await until(() => time >= runEnd || room(d) < body.speed * 0.6 + 60);
    body.play('Walk', jitter());
    const walkEnd = time + skew(T.walkAfterRun);
    await until(() => time >= walkEnd || room(d) < 30);
    await halt();
  }
  async function sit() {
    await oneShot('SitDown');
    await sleep(skew(T.sit));
    await oneShot('SitUp');
    if (chance(0.2 + (1 - energy) * 0.4)) await lie(); // 앉아 쉬다 아예 엎드리기
  }
  async function lie() {
    await oneShot('LieDown');
    await sleep(skew(T.lie) * (1.5 - energy));
    await oneShot('LieUp');
    if (chance(0.3)) await loop('PlayBow', 1); // 일어나서 기지개
  }
  const FLOWS = {
    stroll,
    run: async () => {
      await runBurst();
      if (energy < 0.5 && chance(0.5)) await sit();
    },
    sniff: () => loop('GroundSniff', reps(1, 2)),
    lookAround: async () => {
      await loop('LookAround', 1);
      if (chance(0.4)) await stroll();
    },
    lookUp: () => loop('LookUp', reps(1, 2)),
    wagSoft: () => loop('TailWagSoft', reps(1, 2)),
    playBow: async () => {
      await loop('PlayBow', reps(1, 2));
      if (energy > 0.5 && chance(0.5)) await runBurst();
    },
    sit,
    lie,
    tailLow: async () => {
      await oneShot('TailLower');
      await sleep(skew(T.tailLow));
      await oneShot('TailRaise');
    },
    yawn: () => oneShot('Yawn'),
  };

  // 오래 입력이 없으면 하던 일을 멈추고 엎드려 잠든다. 입력이 생기면 T.wakeDelay 뒤에 깨서 엎드린 채 잠깐 있다가 일어난다.
  async function doze() {
    sleeping = true;
    interrupt();
    try {
      log(`${time.toFixed(0)}s 잠들기`);
      await until(() => body.clipLoops); // 앉거나 엎드리는 중이면 다 한 뒤에
      if (body.state !== 'lie' || body.dir !== SLEEP_DIR) {
        await standUp();
        await turn(SLEEP_DIR);
        await halt();
        await oneShot('LieDown');
      }
      await oneShot('FallAsleep');
      await until(() => body.idle < T.sleepAfterIdle);
      await sleep(T.wakeDelay);
      log(`${time.toFixed(0)}s 깨기`);
      await oneShot('WakeUp');
      await sleep(skew([1, 4]));
      await oneShot('LieUp');
      if (chance(0.6)) await oneShot('Yawn');
    } catch (e) {
      if (e !== CANCEL) throw e;
    } finally {
      sleeping = false;
    }
  }

  function pick() {
    const entries = Object.entries(WEIGHTS).map(([k, f]) => [k, f(energy) * (penalty[k] ?? 1)]);
    let r = Math.random() * entries.reduce((s, [, w]) => s + w, 0);
    const [name] = entries.find(([, w]) => (r -= w) < 0) ?? entries[0];
    for (const k in penalty) penalty[k] = Math.min(1, penalty[k] + T.repeatRecover);
    penalty[name] = T.repeatPenalty;
    return name;
  }

  async function life(gen) {
    while (running && gen === generation) {
      try {
        await until(() => !petting && !sleeping && !body.held);
        await standUp();
        await sleep(skew(T.standWait));
        const name = pick();
        log(`${time.toFixed(0)}s 기운 ${energy.toFixed(2)} → ${name}`);
        await FLOWS[name]();
      } catch (e) {
        if (e !== CANCEL) throw e;
      }
    }
  }

  return {
    get energy() { return energy; },
    get running() { return running; },
    start() {
      if (running) return;
      running = true;
      life(++generation);
    },
    stop() {
      running = false;
      interrupt();
    },
    // 들어 올리면 하던 일을 그만둔다. body.held가 풀리면(착지) 다시 고른다.
    hold: interrupt,
    // 쓰다듬기: 하던 일을 멈추고 일어나서 반갑게 꼬리를 흔든다.
    async pet() {
      if (!running || petting || sleeping || body.held) return; // 자는 중에 누른 것도 입력이라 곧 깬다
      petting = true;
      interrupt();
      try {
        await standUp();
        log(`${time.toFixed(0)}s 쓰다듬기`);
        await loop('TailWagHappy', reps(2, 3));
        energy = Math.min(1, energy + T.energyPet);
      } catch (e) {
        if (e !== CANCEL) throw e;
      } finally {
        petting = false;
      }
    },
    tick(dt) {
      time += dt;
      const rate = T.energyDrift + (T.energyPerSec[body.clip] ?? T.energyPerSec[body.state] ?? 0);
      energy = Math.min(1, Math.max(0, energy + rate * dt));
      if (running && !sleeping && !petting && !body.held && body.idle >= T.sleepAfterIdle) doze();
      for (const w of waiters) if (w.pred()) (waiters.delete(w), w.resolve());
    },
  };
}
