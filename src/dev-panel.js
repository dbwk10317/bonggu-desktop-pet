// 개발용 조작 패널: 자동 행동 켜고 끄기, 클립 재생, 방향 전환, 카메라 기울기. vite dev에서만 불러온다.
export function mount({ clips, play, turn, brain, tilt, setTilt }) {
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;top:8px;left:8px;display:flex;flex-wrap:wrap;gap:4px;max-width:420px;' +
    'font:12px system-ui;background:#fffd;padding:8px;border-radius:6px';
  const now = document.createElement('div');
  now.style.cssText = 'width:100%;font-weight:600';
  let clipName = '';
  const refresh = () =>
    (now.textContent = `${brain.running ? '자동' : '수동'} · ${clipName} · 기운 ${brain.energy.toFixed(2)}`);
  setInterval(refresh, 500);

  const button = (text, onclick, title = '') => {
    const b = Object.assign(document.createElement('button'), { textContent: text, title, onclick });
    panel.append(b);
    return b;
  };

  panel.append(now);
  button('▶ 자동 행동', () => (brain.start(), refresh()));
  for (const c of clips) button(c.label, () => play(c.name), c.name); // 누르면 자동 행동이 멈춘다
  button('↔ 방향', turn);

  const label = document.createElement('label');
  label.style.cssText = 'width:100%';
  const range = Object.assign(document.createElement('input'), { type: 'range', min: 0, max: 40, value: tilt });
  const deg = document.createElement('span');
  deg.textContent = `${tilt}°`;
  range.oninput = () => ((deg.textContent = `${range.value}°`), setTilt(Number(range.value)));
  label.append('카메라 기울기 ', range, deg);
  panel.append(label);

  document.body.append(panel);
  return { show: (name) => ((clipName = name), refresh()) };
}
