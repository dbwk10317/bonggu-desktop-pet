// 형제 저장소의 모델과 동작 계약을 public/model/로 복사한다. 경로는 BONGGU_MODEL_DIR로 바꿀 수 있다.
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = resolve(process.env.BONGGU_MODEL_DIR ?? '../bonggu-3d-model', 'locomotion');
const dst = resolve('public/model');
const { model } = JSON.parse(readFileSync(resolve(src, 'clips.json'), 'utf8'));

mkdirSync(dst, { recursive: true });
for (const file of ['clips.json', model]) cpSync(resolve(src, file), resolve(dst, file));
console.log(`model copied: ${src} -> ${dst}`);
