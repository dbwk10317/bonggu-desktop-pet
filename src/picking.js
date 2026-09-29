// SkinnedMesh의 경계는 자동 갱신되지 않는다. 누르는 순간에만 현재 자세로 계산한다.
export function hitsModel(raycaster, model, excluded) {
  model.updateMatrixWorld(true);
  model.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    o.computeBoundingBox();
    o.computeBoundingSphere();
  });
  return raycaster.intersectObject(model, true).some((h) => h.object !== excluded);
}
