// 개발용 조작 패널: 클립 재생, 방향 전환, 카메라 기울기. vite dev에서만 불러온다.
export function mount({ clips, play, turn, tilt, setTilt }) {
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;top:8px;left:8px;display:flex;flex-wrap:wrap;gap:4px;max-width:420px;' +
    'font:12px system-ui;background:#fffd;padding:8px;border-radius:6px';
  const now = document.createElement('div');
  now.style.cssText = 'width:100%;font-weight:600';
  panel.append(now);

  for (const c of clips) {
    const b = document.createElement('button');
    b.textContent = c.label;
    b.title = c.name;
    b.onclick = () => play(c.name);
    panel.append(b);
  }

  const turnBtn = document.createElement('button');
  turnBtn.textContent = '↔ 방향';
  turnBtn.onclick = turn;

  const label = document.createElement('label');
  label.style.cssText = 'width:100%';
  const range = Object.assign(document.createElement('input'), { type: 'range', min: 0, max: 40, value: tilt });
  const deg = document.createElement('span');
  deg.textContent = `${tilt}°`;
  range.oninput = () => ((deg.textContent = `${range.value}°`), setTilt(Number(range.value)));
  label.append('카메라 기울기 ', range, deg);

  panel.append(turnBtn, label);
  document.body.append(panel);
  return { show: (name) => (now.textContent = `재생 중: ${name}`) };
}
