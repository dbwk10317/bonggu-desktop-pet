// Tauri 창에서만 쓰는 부분: 봉구 밖 클릭 통과, 트레이 크기 메뉴. 모니터 선택은 Rust(main.rs)가 맡는다.
import { getCurrentWindow, cursorPosition } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const SIZES = { small: 100, medium: 140, large: 190 }; // 봉구 화면 높이(px)
const PROBE_MS = 50; // 커서 확인 주기(약 20Hz)
const SOLID_ALPHA = 128; // 이보다 불투명한 픽셀만 봉구로 본다(그림자 제외)

export async function attach({ renderer, setHeight }) {
  const win = getCurrentWindow();
  const gl = renderer.getContext();
  const canvas = renderer.domElement;
  const pixel = new Uint8Array(4);
  let passThrough = true;
  let held = false;
  let probe = null; // 다음 렌더 직후 알파를 읽을 창 픽셀
  await win.setIgnoreCursorEvents(true);

  // 창 위치는 모니터를 바꿀 때만 바뀌므로 매번 묻지 않고 이동 이벤트로 갱신한다.
  let origin = await win.outerPosition();
  win.onMoved(({ payload }) => (origin = payload));
  setInterval(async () => {
    const cursor = await cursorPosition();
    probe = { x: Math.round(cursor.x - origin.x), y: Math.round(cursor.y - origin.y) };
  }, PROBE_MS);

  listen('size', (e) => SIZES[e.payload] && setHeight(SIZES[e.payload]));

  // 시스템 전체 마지막 입력 뒤로 지난 초. 잠들기·깨기에 쓴다.
  let idle = 0;
  setInterval(async () => (idle = await invoke('idle_seconds')), 1000);

  return {
    get idle() {
      return idle;
    },
    // 들고 있는 동안은 커서가 봉구 밖으로 잠깐 벗어나도 놓치지 않게 클릭 통과를 끈다.
    hold(on) {
      held = on;
    },
    // 렌더 직후 호출. 커서 아래 픽셀이 봉구일 때만 클릭을 받는다.
    afterRender() {
      if (!probe) return;
      const x = probe.x;
      const y = probe.y - Math.round(canvas.getBoundingClientRect().top * devicePixelRatio); // 캔버스는 창 바닥에 붙어 있다
      probe = null;
      let solid = held;
      if (!solid && x >= 0 && y >= 0 && x < canvas.width && y < canvas.height) {
        gl.readPixels(x, canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        solid = pixel[3] > SOLID_ALPHA;
      }
      if (solid === passThrough) {
        passThrough = !solid;
        win.setIgnoreCursorEvents(passThrough);
      }
    },
  };
}
