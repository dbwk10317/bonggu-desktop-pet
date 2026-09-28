// Tauri 창에서만 쓰는 부분: 봉구 밖 클릭 통과, 트레이 크기 메뉴.
import { getCurrentWindow, cursorPosition } from '@tauri-apps/api/window';
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
  let probe = null; // 다음 렌더 직후 알파를 읽을 캔버스 픽셀
  await win.setIgnoreCursorEvents(true);

  setInterval(async () => {
    const [cursor, origin] = await Promise.all([cursorPosition(), win.outerPosition()]);
    probe = { x: Math.round(cursor.x - origin.x), y: Math.round(cursor.y - origin.y) };
  }, PROBE_MS);

  listen('size', (e) => SIZES[e.payload] && setHeight(SIZES[e.payload]));

  return {
    // 렌더 직후 호출. 커서 아래 픽셀이 봉구일 때만 클릭을 받는다.
    afterRender() {
      if (!probe) return;
      const { x, y } = probe;
      probe = null;
      let solid = false;
      if (x >= 0 && y >= 0 && x < canvas.width && y < canvas.height) {
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
