// 読み込んだモデルを「鱗を撒く面」に変換する。
//   - 全メッシュをワールド座標(m)に焼き込み、位置で溶接する(UV の切れ目で頂点が分かれたままだと
//     法線が割れ、流れのぼかしも島ごとに切れるため)
//   - 入力の法線は使わず、溶接後のトポロジーから再計算する
//   - UV は三角形の角ごとに持つ(溶接しても UV は分けたまま)
import * as THREE from 'three';

export interface Surface {
  positions: Float32Array;   // 溶接後の頂点位置 V*3 [m]
  normals: Float32Array;     // 溶接後の頂点法線 V*3
  tris: Uint32Array;         // T*3 溶接頂点番号
  triUV: Float32Array;       // T*6 角ごとの UV
  triMat: Uint16Array;       // T   マテリアル番号
  materials: string[];
  uvTiles: number[];         // マテリアルごとの UV タイル(0〜1 の枠)の数。2 以上ならタイル同士が重なって描かれる
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
}

export function buildSurface(root: THREE.Object3D, unitScale: number): Surface {
  root.updateMatrixWorld(true);
  const matIndex = new Map<string, number>();
  const materials: string[] = [];
  const pos: number[] = [];
  const uv: number[] = [];
  const mat: number[] = [];

  const v = new THREE.Vector3();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const g = mesh.geometry as THREE.BufferGeometry;
    const pa = g.getAttribute('position');
    const ua = g.getAttribute('uv');
    if (!pa || !ua) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const index = g.getIndex();
    const nIdx = index ? index.count : pa.count;
    const groups = g.groups.length > 0 ? g.groups : [{ start: 0, count: nIdx, materialIndex: 0 }];
    for (const grp of groups) {
      const m = mats[grp.materialIndex ?? 0] ?? mats[0];
      const name = (m && m.name) || `material_${materials.length}`;
      let mi = matIndex.get(name);
      if (mi === undefined) { mi = materials.length; matIndex.set(name, mi); materials.push(name); }
      const end = Math.min(grp.start + grp.count, nIdx);
      for (let i = grp.start; i + 2 < end; i += 3) {
        for (let k = 0; k < 3; k++) {
          const vi = index ? index.getX(i + k) : i + k;
          v.fromBufferAttribute(pa, vi).applyMatrix4(mesh.matrixWorld).multiplyScalar(unitScale);
          pos.push(v.x, v.y, v.z);
          uv.push(ua.getX(vi), ua.getY(vi));
        }
        mat.push(mi);
      }
    }
  });
  return weld(new Float32Array(pos), new Float32Array(uv), new Uint16Array(mat), materials);
}

function weld(cornerPos: Float32Array, cornerUV: Float32Array, cornerMat: Uint16Array, materials: string[]): Surface {
  const nc = cornerPos.length / 3;
  const bmin = [Infinity, Infinity, Infinity];
  const bmax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nc; i++) {
    for (let a = 0; a < 3; a++) {
      const x = cornerPos[i * 3 + a];
      if (x < bmin[a]) bmin[a] = x;
      if (x > bmax[a]) bmax[a] = x;
    }
  }
  const diag = Math.hypot(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]) || 1;
  const eps = diag * 1e-6;

  const key2id = new Map<string, number>();
  const wpos: number[] = [];
  const cornerId = new Uint32Array(nc);
  for (let i = 0; i < nc; i++) {
    const x = cornerPos[i * 3], y = cornerPos[i * 3 + 1], z = cornerPos[i * 3 + 2];
    const key = `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`;
    let id = key2id.get(key);
    if (id === undefined) { id = wpos.length / 3; key2id.set(key, id); wpos.push(x, y, z); }
    cornerId[i] = id;
  }
  const positions = new Float32Array(wpos);

  // 3 頂点がつぶれた三角形・面積ゼロの三角形は捨てる(法線が 0 になり、散布の対象にもならない)
  const tris: number[] = [];
  const triUV: number[] = [];
  const triMat: number[] = [];
  const nt = nc / 3;
  const minArea2 = (eps * eps) * 1e-2;
  for (let t = 0; t < nt; t++) {
    const a = cornerId[t * 3], b = cornerId[t * 3 + 1], c = cornerId[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    if (triArea2(positions, a, b, c) <= minArea2) continue;
    tris.push(a, b, c);
    for (let k = 0; k < 6; k++) triUV.push(cornerUV[t * 6 + k]);
    triMat.push(cornerMat[t]);
  }
  const trisA = new Uint32Array(tris);
  // UV が 0〜1 の外にある三角形は、重心のあるタイルごと 0〜1 に戻す(Unity は UDIM を扱えないので繰り返しとして扱う)
  const tileSets = materials.map(() => new Set<string>());
  for (let t = 0; t < triMat.length; t++) {
    const tu = Math.floor((triUV[t * 6] + triUV[t * 6 + 2] + triUV[t * 6 + 4]) / 3);
    const tv = Math.floor((triUV[t * 6 + 1] + triUV[t * 6 + 3] + triUV[t * 6 + 5]) / 3);
    tileSets[triMat[t]].add(`${tu},${tv}`);
    if (tu === 0 && tv === 0) continue;
    for (let c = 0; c < 3; c++) { triUV[t * 6 + c * 2] -= tu; triUV[t * 6 + c * 2 + 1] -= tv; }
  }
  return {
    positions,
    normals: vertexNormals(positions, trisA),
    tris: trisA,
    triUV: new Float32Array(triUV),
    triMat: new Uint16Array(triMat),
    materials,
    uvTiles: tileSets.map((st) => st.size),
    bboxMin: bmin as [number, number, number],
    bboxMax: bmax as [number, number, number],
  };
}

function triArea2(p: Float32Array, a: number, b: number, c: number): number {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  return Math.hypot(cx, cy, cz);
}

// 面積で重み付けした頂点法線
function vertexNormals(p: Float32Array, tris: Uint32Array): Float32Array {
  const n = new Float32Array(p.length);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    for (const i of [a, b, c]) { n[i * 3] += cx; n[i * 3 + 1] += cy; n[i * 3 + 2] += cz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (l > 0) { n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; } else { n[i + 1] = 1; }
  }
  return n;
}

// 頂点の隣接(CSR)。流れのぼかしに使う
export function vertexAdjacency(nv: number, tris: Uint32Array): { start: Uint32Array; list: Uint32Array } {
  const sets: Set<number>[] = Array.from({ length: nv }, () => new Set<number>());
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    sets[a].add(b); sets[a].add(c); sets[b].add(a); sets[b].add(c); sets[c].add(a); sets[c].add(b);
  }
  const start = new Uint32Array(nv + 1);
  for (let i = 0; i < nv; i++) start[i + 1] = start[i] + sets[i].size;
  const list = new Uint32Array(start[nv]);
  for (let i = 0; i < nv; i++) { let k = start[i]; for (const j of sets[i]) list[k++] = j; }
  return { start, list };
}

export function surfaceArea(s: Surface, matMask: boolean[]): number {
  let a = 0;
  for (let t = 0; t < s.triMat.length; t++) {
    if (!matMask[s.triMat[t]]) continue;
    a += 0.5 * triArea2(s.positions, s.tris[t * 3], s.tris[t * 3 + 1], s.tris[t * 3 + 2]);
  }
  return a;
}

// 選んだマテリアルの UV 面積(0〜1 の正方形に対する割合)。重なった UV は二重に数える
export function uvArea(s: Surface, matMask: boolean[]): number {
  let a = 0;
  for (let t = 0; t < s.triMat.length; t++) {
    if (!matMask[s.triMat[t]]) continue;
    const u = s.triUV;
    const ax = u[t * 6], ay = u[t * 6 + 1];
    a += 0.5 * Math.abs((u[t * 6 + 2] - ax) * (u[t * 6 + 5] - ay) - (u[t * 6 + 4] - ax) * (u[t * 6 + 3] - ay));
  }
  return a;
}
