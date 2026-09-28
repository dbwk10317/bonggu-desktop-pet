# 봉구 데스크톱 펫 · 계획

봉구 3D 모델이 macOS·Windows 바탕화면 아래쪽을 돌아다니는 데스크톱 펫 앱.
모델 자산은 형제 저장소 `bonggu-3d-model`이 원본이고, 이 저장소는 앱 코드만 가진다.

## 결정 사항

- **Tauri 2 + three.js** (Vite, 바닐라 JS). 하루 종일 켜 두는 앱이라 가벼운 쪽을 골랐다.
- 모델은 `../bonggu-3d-model/locomotion/bonggu-v2-everyday.glb`, 동작 계약은 같은 폴더의 `clips.json`.
  빌드 전에 `public/model/`로 복사하고 Git에는 넣지 않는다. 경로는 `BONGGU_MODEL_DIR` 환경변수로
  바꿀 수 있고 기본값은 상대경로 `../bonggu-3d-model`이다. 개인 절대경로를 코드에 넣지 않는다.
- 모델 저장소를 고치지 않는다. 앱에서 드러난 모델 문제는 그 저장소에서 따로 처리한다.

## 현재 개발 환경 (2026-09-28, Windows 11)

| 항목 | 상태 |
|---|---|
| Node / npm | v26.8.1 / 12.0.2 |
| WebView2 | 153 설치됨 |
| Rust (rustup, cargo) | **미설치** |
| MSVC C++ Build Tools | **미설치** (vswhere 없음) |

Tauri 빌드 전에 Rust와 Visual Studio Build Tools(“C++를 사용한 데스크톱 개발”)가 필요하다.
설치는 사용자 확인 후 진행한다. 그 전에도 프런트엔드는 `vite dev`로 브라우저에서 개발·확인할 수 있다.

## 창 구성

- 주 모니터 작업 영역(작업 표시줄 제외) 바닥에 붙은 **전체 너비 띠 창**(높이 약 300px).
  창을 매 프레임 옮기지 않고 봉구가 캔버스 안에서 움직인다(Windows에서 창 이동이 끊겨 보이는 문제 회피).
- `transparent`, `decorations: false`, `alwaysOnTop`, `skipTaskbar`, `shadow: false`, `resizable: false`.
- macOS 투명 창은 `app.macOSPrivateApi: true`가 필요하다.
- **클릭 통과**: 기본은 `setIgnoreCursorEvents(true)`. `cursorPosition()`을 약 20Hz로 읽어 창 좌표로 바꾸고,
  렌더 직후 그 픽셀의 알파를 `gl.readPixels`로 1px 읽어 봉구 위일 때만 통과를 끈다.
- capabilities에 필요한 창 권한만 넣는다(ignore-cursor-events, cursor-position, 모니터 조회, 위치·크기).
- 트레이 아이콘: 종료, 크기(작게/보통/크게). 그 외 설정은 필요해질 때 추가한다.

## 렌더링

- `GLTFLoader`로 GLB 로드. 재질은 `KHR_materials_unlit`(MeshBasicMaterial)이라 조명이 필요 없다.
- **직교 카메라**, 1m = `ppm` 픽셀. 로드 시 모델 높이를 재서 목표 화면 높이(보통 약 140px)로 `ppm`을 정한다.
  직교라서 `forward_speed_mps × ppm`이 곧 화면 속도가 되고 발이 미끄러지지 않는다.
- 모델 전방은 glTF +Z. 진행 방향(±X)으로 돌리되 얼굴이 보이도록 카메라 쪽으로 약 20° 더 돌린다.
  화면 이동 속도에 `cos(20°)`를 곱해 발 미끄러짐을 맞춘다. 방향 전환은 약 0.4초 회전.
- 투명 배경: `alpha: true`, `setClearColor(0x000000, 0)`, premultiplied alpha 확인.
- 쉬는 상태에서는 프레임률을 낮추는 것을 고려한다(측정 후 결정).

## 동작 (clips.json 계약)

- 상태: `stand`, `sit`, `lie`, `tail-low`, `walk`, `run`. 상태별 대기 루프:
  stand→`Idle`, sit→`SitIdle`, lie→`LieIdle`, tail-low→`TailLowIdle`, walk→`Walk`, run→`Run`.
- 한 번 재생 클립(`loop: false`)은 `LoopOnce` + `clampWhenFinished`로 재생한 뒤 `exit_state` 대기 루프로 넘어간다.
  모든 클립이 대기 루프 첫 프레임에서 시작·종료하므로 전환 시 대기 루프를 **0초부터** 시작한다.
- 서 있는 상태의 루프 행동(PlayBow, LookAround, GroundSniff, LookUp, TailWagSoft, TailWagHappy)은
  몇 회 반복 후 `Idle`로 돌아간다.
- Idle↔Walk↔Run은 `locomotion_blend_seconds`(0.18초) 크로스페이드. 이동 속도도 가중치에 맞춰 올리고 내린다.
- `root_motion: false` — 걷기·달리기는 제자리 클립이라 앱이 X 위치를 옮긴다.
- `Smile` 모프: GLB 클립에 모프 애니메이션이 없다. 현재 클립의 `smile` 값을 향해 앱이 부드럽게 보간한다.
- `animations/`의 이전 골격 행동 팩(`previous_behaviors`)은 사용하지 않는다.

### 행동 선택 (간단한 타이머 기반)

- stand: 몇 초 대기 후 가중치 랜덤으로 다음 행동 — 걷기(목표 X 선택), 가끔 달리기, 앉기, 엎드리기,
  둘러보기, 냄새 맡기, 올려보기, 꼬리 살랑, 놀자 자세, 꼬리 내리기.
- sit 10–40초, lie 20–90초, tail-low 8–20초 뒤 일어나기/올리기.
- 화면 가장자리에 닿으면 방향을 바꾼다.
- 클릭(쓰다듬기): 서 있으면 `TailWagHappy`, 앉거나 엎드려 있으면 먼저 일어나서 반응.

## 단계

1. **스캐폴드**: `package.json`(three, vite, @tauri-apps/api, @tauri-apps/cli), `index.html`, `src/main.js`,
   모델 복사 스크립트(`predev`/`prebuild`). `.gitignore`에 `node_modules`, `dist`, `public/model`, `src-tauri/target`.
2. **브라우저에서 렌더링 확인**: 투명 배경 위 봉구, 직교 카메라, 18개 클립 재생, Smile 보간.
3. **상태 머신과 행동 선택**: 위 규칙 구현. 상태 전환이 끊기지 않는지 눈으로 확인.
4. **Tauri 셸** (Rust·Build Tools 설치 후): 띠 창, 클릭 통과, 트레이. `tauri icon`으로
   `bonggu-3d-model/release/bonggu-v2-preview.png`에서 아이콘 생성.
5. **검증**: Windows에서 실행 — 투명·항상 위·봉구 밖 클릭 통과, 모든 전환, 메모리·CPU·GPU 사용량 측정.
   macOS는 해당 기기에서 같은 항목 확인.

## 나중에 (필요해지면)

- 커서 쳐다보기: GLB에는 드라이버가 구운 본 애니메이션만 있어서 앱에서 목·머리 본을 절차적으로 더 돌려야 한다.
- 드래그로 옮기기, 여러 모니터, 자동 시작, 설정 창, 자동 업데이트, 코드 서명.
