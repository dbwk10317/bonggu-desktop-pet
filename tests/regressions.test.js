import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createBrain } from '../src/behavior.js';
import { hitsModel } from '../src/picking.js';

for (const direction of [-1, 1]) {
  test(`walking stays visible after the screen shrinks (direction ${direction})`, async (t) => {
    t.mock.method(Math, 'random', () => 0.1);
    const history = [];
    const body = {
      clips: [], blendSeconds: 0.18, clipSeconds: () => 4,
      x: direction * 700, halfWidth: 1280, dir: direction, turned: true,
      held: false, idle: 0, clip: 'Idle', speed: 0, clipLoops: true,
      get state() { return this.clip === 'Walk' ? 'walk' : 'stand'; },
      play(name) { this.clip = name; this.speed = name === 'Walk' ? 100 : 0; history.push(name); },
      face(d) { this.dir = d; },
    };
    const brain = createBrain(body);
    brain.start();
    let resized = false;
    try {
      for (let frame = 0; frame < 30 * 30; frame++) {
        if (!resized && body.clip === 'Walk') {
          body.halfWidth = 640;
          body.x = direction * 500; // main.js의 resize 보정과 같은 위치
          resized = true;
        }
        body.x += body.dir * body.speed / 30;
        brain.tick(1 / 30);
        for (let i = 0; i < 12; i++) await null;
        if (resized) assert.ok(Math.abs(body.x) < body.halfWidth, `walked offscreen: ${body.x}`);
      }
      assert.ok(resized);
      assert.ok(history.includes('GroundSniff'));
      assert.ok(history.filter((name) => name === 'Walk').length > 1, 'continues after the first waypoint');
    } finally {
      brain.stop();
    }
  });
}

test('picking follows a deformed skinned mesh and still excludes the shadow', () => {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const count = geometry.attributes.position.count;
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) weights[i * 4] = 1;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  const bone = new THREE.Bone();
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
  bone.position.x = 3;
  mesh.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(3, 0, 2), new THREE.Vector3(0, 0, -1));
  assert.equal(ray.intersectObject(mesh).length, 0, 'old bounds reproduce the missed click');
  assert.equal(hitsModel(ray, mesh), true);
  ray.ray.origin.x = 0;
  assert.equal(hitsModel(ray, mesh), false, 'old pose is no longer clickable');
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
  const model = new THREE.Group();
  model.add(mesh, shadow);
  assert.equal(hitsModel(ray, model, shadow), false);
  geometry.dispose();
  mesh.material.dispose();
  shadow.geometry.dispose();
  shadow.material.dispose();
});
