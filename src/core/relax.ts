// 面の上で鱗の中心を押し広げる(Houdini の scatter の Relax Iterations に相当)。
// サンプル間引き法は点を「選ぶ」だけで動かさないので、最近傍距離のばらつきが残る
// (実測: 最近傍距離の変動係数 0.124、Houdini 緩和 400 回は 0.047)。ここで近傍どうしを反発させて六方配置に近づける。
//
// 点は (三角形, 重心座標) で持ち、面の上を歩いて動かす: 三角形の中を直進し、辺に当たったら
// 残りの移動量を辺のまわりに回して隣の三角形の平面へ移し、続きを進む。
// 最寄り面の探索(xyzdist 相当)が要らないので速い。
import { buildHashGrid, cellHash, nextPow2 } from './hashgrid';

export interface RelaxInput {
  positions: Float32Array;
  tris: Uint32Array;
  triMat: Uint16Array;
  matMask: boolean[];
  spacing: number;       // 鱗の間隔 d0 = √(面積 / 枚数)
  iterations: number;
  sizes?: Float32Array;  // 点ごとの大きさの倍率(サイズマップ)。局所の間隔 = d0 × 倍率。省略時は一様
}

// 反発の強さ(1 回に動かす量 = 力 × 六方配置の間隔 × GAIN)と届く距離(六方配置の間隔 × REACH)。
// 実測(Akyo 4.5 万枚): GAIN を 1.0 / 1.5 に上げると行き過ぎて振動し、最近傍距離の変動係数が 0.10〜0.11 に悪化した
const GAIN = 0.5;
const REACH = 1.4;

// pos / tri / bar(三角形の 2 番目・3 番目の角の重み)をその場で更新する
export function relaxOnSurface(
  inp: RelaxInput, n: number, pos: Float32Array, tri: Uint32Array, bar: Float32Array, onProgress?: (f: number) => void,
): void {
  const P = inp.positions, T = inp.tris;
  const nt = T.length / 3;
  const adj = triangleAdjacency(T, nt);
  const fn = faceNormals(P, T, nt);

  // 六方配置での間隔 = √(2/√3) × d0
  const hex = Math.sqrt(2 / Math.sqrt(3)) * inp.spacing;
  const R = hex * REACH;
  const maxStep = inp.spacing * 0.25;
  const disp = new Float32Array(n * 3);
  const sizes = inp.sizes;
  let smax = 1;
  if (sizes) { smax = 0; for (let i = 0; i < n; i++) smax = Math.max(smax, sizes[i]); }

  // 近傍リスト(Verlet リスト): R より skin だけ広く取っておき、
  // リストを作ってからの移動量の最大が skin/2 を超えるまで使い回す(毎回の格子探索を省く)
  const skin = inp.spacing * 0.3 * (sizes ? smax : 1);
  const RL = sizes ? (R * smax) + skin : R + skin;
  const table = nextPow2(n);
  const cell = new Int32Array(n * 3);
  const ref = new Float32Array(n * 3);    // リストを作ったときの位置
  const nbStart = new Uint32Array(n + 1);
  let nbList = new Int32Array(n * 16);
  const buildList = () => {
    let ox = Infinity, oy = Infinity, oz = Infinity;
    for (let i = 0; i < n; i++) { ox = Math.min(ox, pos[i * 3]); oy = Math.min(oy, pos[i * 3 + 1]); oz = Math.min(oz, pos[i * 3 + 2]); }
    ox -= RL; oy -= RL; oz -= RL;
    const g = buildHashGrid(pos, n, RL, [ox, oy, oz], table);
    for (let i = 0; i < n; i++) {
      cell[i * 3] = Math.floor((pos[i * 3] - ox) / RL);
      cell[i * 3 + 1] = Math.floor((pos[i * 3 + 1] - oy) / RL);
      cell[i * 3 + 2] = Math.floor((pos[i * 3 + 2] - oz) / RL);
    }
    const RL2 = RL * RL;
    let m = 0;
    for (let i = 0; i < n; i++) {
      nbStart[i] = m;
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const qx = cell[i * 3] + dx, qy = cell[i * 3 + 1] + dy, qz = cell[i * 3 + 2] + dz;
        const h = cellHash(qx, qy, qz, g.mask);
        for (let k = g.start[h], e = g.start[h + 1]; k < e; k++) {
          const j = g.order[k];
          // ハッシュ衝突で別のセルの点が混ざるので、そのセルの点だけを見る(同じバケットの二度引きも防ぐ)
          if (j === i || cell[j * 3] !== qx || cell[j * 3 + 1] !== qy || cell[j * 3 + 2] !== qz) continue;
          const ex = x - pos[j * 3], ey = y - pos[j * 3 + 1], ez = z - pos[j * 3 + 2];
          if (ex * ex + ey * ey + ez * ez >= RL2) continue;
          if (m === nbList.length) { const b = new Int32Array(m * 2); b.set(nbList); nbList = b; }
          nbList[m++] = j;
        }
      }
    }
    nbStart[n] = m;
    ref.set(pos.subarray(0, n * 3));
  };
  buildList();

  for (let it = 0; it < inp.iterations; it++) {
    onProgress?.(it / inp.iterations);
    // --- 反発力(ヤコビ法: 全点の力を出してから動かす) ---
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      const ti = tri[i];
      const nx = fn[ti * 3], ny = fn[ti * 3 + 1], nz = fn[ti * 3 + 2];
      let fx = 0, fy = 0, fz = 0;
      const si = sizes ? sizes[i] : 1;
      for (let k = nbStart[i], e = nbStart[i + 1]; k < e; k++) {
        const j = nbList[k];
        const ex = x - pos[j * 3], ey = y - pos[j * 3 + 1], ez = z - pos[j * 3 + 2];
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
        // 2 点の間の反発が届く距離は、2 点の大きさの平均で伸縮する
        const Rij = sizes ? R * (si + sizes[j]) * 0.5 : R;
        if (d >= Rij || d < 1e-12) continue;
        // 裏側(薄い部位の反対の面)の点とは反発しない
        const tj = tri[j];
        const facing = nx * fn[tj * 3] + ny * fn[tj * 3 + 1] + nz * fn[tj * 3 + 2];
        if (facing <= 0) continue;
        const w = (1 - d / Rij) * (1 - d / Rij) * facing / d;
        fx += ex * w; fy += ey * w; fz += ez * w;
      }
      // 接平面に落とす
      const fnrm = fx * nx + fy * ny + fz * nz;
      fx -= fnrm * nx; fy -= fnrm * ny; fz -= fnrm * nz;
      const hexI = sizes ? hex * si : hex;
      const stepI = sizes ? maxStep * si : maxStep;
      let mx = fx * hexI * GAIN, my = fy * hexI * GAIN, mz = fz * hexI * GAIN;
      const ml = Math.hypot(mx, my, mz);
      if (ml > stepI) { mx *= stepI / ml; my *= stepI / ml; mz *= stepI / ml; }
      disp[i * 3] = mx; disp[i * 3 + 1] = my; disp[i * 3 + 2] = mz;
    }

    // --- 面の上を歩いて動かす ---
    let maxMove2 = 0;
    for (let i = 0; i < n; i++) {
      walk(P, T, adj, fn, inp.triMat, inp.matMask, i, pos, tri, bar, disp[i * 3], disp[i * 3 + 1], disp[i * 3 + 2]);
      const ex = pos[i * 3] - ref[i * 3], ey = pos[i * 3 + 1] - ref[i * 3 + 1], ez = pos[i * 3 + 2] - ref[i * 3 + 2];
      maxMove2 = Math.max(maxMove2, ex * ex + ey * ey + ez * ez);
    }
    // 2 点がそれぞれ skin/2 動けば、リストに無い点が R の内側に入りうる
    if (it + 1 < inp.iterations && maxMove2 > (skin * 0.5) ** 2) buildList();
  }
}

// 点 i を移動量 d だけ面に沿って動かす。
// 三角形の中を直進し、辺に当たったら残りを辺のまわりに回して隣の三角形の平面へ移して続ける(展開して歩く)。
// 境界(隣が無い / 鱗を撒かないマテリアル)に当たったらそこで止まる。
// ⚠ 目標点を隣の平面へ単純に投影する方法は、折れ目で同じ辺を行き来して点が辺に張り付く(実測で最近傍 0.21 × 間隔の組が出た)
function walk(
  P: Float32Array, T: Uint32Array, adj: Int32Array, fn: Float32Array, triMat: Uint16Array, matMask: boolean[],
  i: number, pos: Float32Array, tri: Uint32Array, bar: Float32Array, dx: number, dy: number, dz: number,
): void {
  let t = tri[i];
  let px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
  // 最初の三角形の平面に落とす
  const dn = dx * fn[t * 3] + dy * fn[t * 3 + 1] + dz * fn[t * 3 + 2];
  dx -= dn * fn[t * 3]; dy -= dn * fn[t * 3 + 1]; dz -= dn * fn[t * 3 + 2];
  let from = -1;
  for (let step = 0; step < 16; step++) {
    const c0 = barycentric(P, T, t, px, py, pz);
    const c1 = barycentric(P, T, t, px + dx, py + dy, pz + dz);
    if (c1[0] >= 0 && c1[1] >= 0 && c1[2] >= 0) { px += dx; py += dy; pz += dz; break; }
    // 線分が最初に外へ出る辺(座標が 0 になる所)
    let sMin = 1, edge = -1;
    for (let k = 0; k < 3; k++) {
      if (c1[k] >= 0) continue;
      const s = Math.max(0, c0[k]) / (Math.max(0, c0[k]) - c1[k]);
      if (s < sMin || edge < 0) { sMin = s; edge = k; }
    }
    px += dx * sMin; py += dy * sMin; pz += dz * sMin;
    const rx = dx * (1 - sMin), ry = dy * (1 - sMin), rz = dz * (1 - sMin);
    const nb = adj[t * 3 + edge];
    if (nb < 0 || !matMask[triMat[nb]] || nb === from) break;
    // 残りの移動量を、辺方向の成分はそのまま、辺に垂直な成分は隣の三角形の内側へ向けて移す
    const ea = T[t * 3 + (edge + 1) % 3], eb = T[t * 3 + (edge + 2) % 3];
    let ex = P[eb * 3] - P[ea * 3], ey = P[eb * 3 + 1] - P[ea * 3 + 1], ez = P[eb * 3 + 2] - P[ea * 3 + 2];
    const el = Math.hypot(ex, ey, ez) || 1;
    ex /= el; ey /= el; ez /= el;
    const along = rx * ex + ry * ey + rz * ez;
    const perp = Math.hypot(rx - along * ex, ry - along * ey, rz - along * ez);
    // 隣の三角形の平面内で辺に垂直、かつ隣の三角形の内側(辺の向かいの角の側)を向く方向
    const nx = fn[nb * 3], ny = fn[nb * 3 + 1], nz = fn[nb * 3 + 2];
    let qx = ny * ez - nz * ey, qy = nz * ex - nx * ez, qz = nx * ey - ny * ex;
    let opp = T[nb * 3];
    if (opp === ea || opp === eb) opp = T[nb * 3 + 1];
    if (opp === ea || opp === eb) opp = T[nb * 3 + 2];
    if (qx * (P[opp * 3] - P[ea * 3]) + qy * (P[opp * 3 + 1] - P[ea * 3 + 1]) + qz * (P[opp * 3 + 2] - P[ea * 3 + 2]) < 0) {
      qx = -qx; qy = -qy; qz = -qz;
    }
    dx = ex * along + qx * perp; dy = ey * along + qy * perp; dz = ez * along + qz * perp;
    from = t;
    t = nb;
  }
  // 三角形の中に収める(数値誤差と、境界で止まった場合)
  let [w, u, v] = barycentric(P, T, t, px, py, pz);
  if (w < 0 || u < 0 || v < 0) {
    w = Math.max(0, w); u = Math.max(0, u); v = Math.max(0, v);
    const s = w + u + v || 1;
    w /= s; u /= s; v /= s;
  }
  const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
  for (let k = 0; k < 3; k++) pos[i * 3 + k] = P[a * 3 + k] * w + P[b * 3 + k] * u + P[c * 3 + k] * v;
  tri[i] = t; bar[i * 2] = u; bar[i * 2 + 1] = v;
}

// q を三角形 t の平面に落としたときの重心座標 (角 0, 角 1, 角 2)
function barycentric(P: Float32Array, T: Uint32Array, t: number, qx: number, qy: number, qz: number): [number, number, number] {
  const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
  const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
  const v0x = P[b * 3] - ax, v0y = P[b * 3 + 1] - ay, v0z = P[b * 3 + 2] - az;
  const v1x = P[c * 3] - ax, v1y = P[c * 3 + 1] - ay, v1z = P[c * 3 + 2] - az;
  const v2x = qx - ax, v2y = qy - ay, v2z = qz - az;
  const d00 = v0x * v0x + v0y * v0y + v0z * v0z, d01 = v0x * v1x + v0y * v1y + v0z * v1z, d11 = v1x * v1x + v1y * v1y + v1z * v1z;
  const d20 = v2x * v0x + v2y * v0y + v2z * v0z, d21 = v2x * v1x + v2y * v1y + v2z * v1z;
  const den = d00 * d11 - d01 * d01 || 1e-30;
  const u = (d11 * d20 - d01 * d21) / den, v = (d00 * d21 - d01 * d20) / den;
  return [1 - u - v, u, v];
}

// adj[t*3 + e] = 辺 e(角 e+1 と e+2 の間 = 角 e の向かい)の隣の三角形。無ければ -1
function triangleAdjacency(T: Uint32Array, nt: number): Int32Array {
  const adj = new Int32Array(nt * 3).fill(-1);
  const edges = new Map<number, number>();
  const nvApprox = 4294967296;
  for (let t = 0; t < nt; t++) {
    for (let e = 0; e < 3; e++) {
      const p = T[t * 3 + (e + 1) % 3], q = T[t * 3 + (e + 2) % 3];
      const key = p < q ? p * nvApprox + q : q * nvApprox + p;
      const other = edges.get(key);
      if (other === undefined) { edges.set(key, t * 3 + e); continue; }
      adj[t * 3 + e] = Math.floor(other / 3);
      if (adj[other] < 0) adj[other] = t;
    }
  }
  return adj;
}

function faceNormals(P: Float32Array, T: Uint32Array, nt: number): Float32Array {
  const fn = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z) || 1;
    fn[t * 3] = x / l; fn[t * 3 + 1] = y / l; fn[t * 3 + 2] = z / l;
  }
  return fn;
}
