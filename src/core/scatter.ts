// 面上に鱗の中心を撒き、1 枚ごとの向き・乱数を決める。
// Houdini 版は scatter + 緩和 400 回。ここではサンプル間引き法(Yuksel 2015)で
// 候補を多めに撒いてから重み付きで間引き、1 パスで青色ノイズ的な分布を得る。
import { buildHashGrid, cellHash, nextPow2 } from './hashgrid';
import { tangentDir } from './flow';
import { relaxOnSurface } from './relax';

export interface ScatterInput {
  positions: Float32Array;
  normals: Float32Array;
  tris: Uint32Array;
  triMat: Uint16Array;
  triUV: Float32Array;      // 角ごとの UV(鱗の中心の UV を出すため)
  flow: Float32Array;       // 頂点ごとの進行方向
  matMask: boolean[];       // 鱗を撒くマテリアル
  spacing: number;          // 鱗の間隔 [m]。枚数 = 面積 / spacing²
  seed: number;
  relaxIterations?: number; // 間引きのあとの押し広げ回数
}

export interface Scales {
  count: number;
  pos: Float32Array;     // N*3
  nrm: Float32Array;     // N*3
  rowdir: Float32Array;  // N*3 鱗の縦(後縁が向く先)
  coldir: Float32Array;  // N*3 鱗の横
  sid: Float32Array;     // N   鱗ごとの乱数 [0,1)
  uv: Float32Array;      // N*2 鱗の中心の UV
  mat: Uint16Array;      // N   鱗の中心が乗っているマテリアル
  tri: Uint32Array;      // N   鱗の中心が乗っている三角形
  area: number;
}

// 押し広げの回数。実測(Akyo 4.5 万枚、間隔 d0 で割った値):
//   0 回: 最近傍の変動係数 0.124 / 隙間 99% 点 0.818、40 回: 0.043 / 0.625(Houdini 緩和 400 回: 0.047 / 0.608)
export const RELAX_ITERATIONS = 40;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 進み具合の報告: 段階名と、その段階の中での割合 0〜1
export type Progress = (stage: 'eliminate' | 'relax' | 'separate', f: number) => void;

export function scatterScales(inp: ScatterInput, onProgress?: Progress): Scales {
  const { positions: P, tris, triMat } = inp;
  const rng = mulberry32(inp.seed * 7919 + 17);

  // --- 面積に比例した三角形の選択 ---
  const tlist: number[] = [];
  const cdf: number[] = [];
  let area = 0;
  for (let t = 0; t < triMat.length; t++) {
    if (!inp.matMask[triMat[t]]) continue;
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    tlist.push(t);
    cdf.push(area);
  }
  const N = Math.max(1, Math.round(area / (inp.spacing * inp.spacing)));
  // 候補の倍率。論文の既定は 5 倍だが、3 倍でも最近傍距離の分布はほぼ同じで 2.5 倍速い
  // (実測 10 万枚: 5 倍 4.6 秒 / 3 倍 1.8 秒、最近傍距離 1% 点 0.685 → 0.655 × 間隔)
  const M = N * 3;

  // --- 候補を撒く ---
  const cpos = new Float32Array(M * 3);
  const ctri = new Uint32Array(M);
  const cbar = new Float32Array(M * 2);
  for (let i = 0; i < M; i++) {
    const r = rng() * area;
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; }
    const t = tlist[lo];
    let u = rng(), v = rng();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      cpos[i * 3 + k] = P[a * 3 + k] * (1 - u - v) + P[b * 3 + k] * u + P[c * 3 + k] * v;
    }
    ctri[i] = t; cbar[i * 2] = u; cbar[i * 2 + 1] = v;
  }

  const keep = eliminate(cpos, M, N, area, (f) => onProgress?.('eliminate', f));

  // --- 面の上で押し広げる ---
  const n = keep.length;
  const kpos = new Float32Array(n * 3), ktri = new Uint32Array(n), kbar = new Float32Array(n * 2);
  for (let s = 0; s < n; s++) {
    const i = keep[s];
    kpos.set(cpos.subarray(i * 3, i * 3 + 3), s * 3);
    ktri[s] = ctri[i]; kbar[s * 2] = cbar[i * 2]; kbar[s * 2 + 1] = cbar[i * 2 + 1];
  }
  relaxOnSurface({
    positions: P, tris, triMat, matMask: inp.matMask, spacing: Math.sqrt(area / n),
    iterations: inp.relaxIterations ?? RELAX_ITERATIONS,
  }, n, kpos, ktri, kbar, (f) => onProgress?.('relax', f));

  // --- 1 枚ごとの属性 ---
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
  const rowdir = new Float32Array(n * 3), coldir = new Float32Array(n * 3), sid = new Float32Array(n);
  const uv = new Float32Array(n * 2), mat = new Uint16Array(n), tri = new Uint32Array(n);
  const srng = mulberry32(inp.seed * 104729 + 3);
  for (let s = 0; s < n; s++) {
    const t = ktri[s], u = kbar[s * 2], v = kbar[s * 2 + 1], w = 1 - u - v;
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    let nx = 0, ny = 0, nz = 0, fx = 0, fy = 0, fz = 0;
    for (const [vi, wt] of [[a, w], [b, u], [c, v]] as const) {
      nx += inp.normals[vi * 3] * wt; ny += inp.normals[vi * 3 + 1] * wt; nz += inp.normals[vi * 3 + 2] * wt;
      fx += inp.flow[vi * 3] * wt; fy += inp.flow[vi * 3 + 1] * wt; fz += inp.flow[vi * 3 + 2] * wt;
    }
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    let [rx, ry, rz] = tangentDir(fx, fy, fz, nx, ny, nz);
    const rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-6) { [rx, ry, rz] = tangentDir(0, 1, 0, nx, ny, nz); }
    const rl2 = Math.hypot(rx, ry, rz) || 1;
    rx /= rl2; ry /= rl2; rz /= rl2;
    // coldir = n × rowdir
    const cx = ny * rz - nz * ry, cy = nz * rx - nx * rz, cz = nx * ry - ny * rx;
    const cl = Math.hypot(cx, cy, cz) || 1;
    pos.set(kpos.subarray(s * 3, s * 3 + 3), s * 3);
    nrm[s * 3] = nx; nrm[s * 3 + 1] = ny; nrm[s * 3 + 2] = nz;
    rowdir[s * 3] = rx; rowdir[s * 3 + 1] = ry; rowdir[s * 3 + 2] = rz;
    coldir[s * 3] = cx / cl; coldir[s * 3 + 1] = cy / cl; coldir[s * 3 + 2] = cz / cl;
    sid[s] = srng();
    const q = inp.triUV;
    uv[s * 2] = q[t * 6] * w + q[t * 6 + 2] * u + q[t * 6 + 4] * v;
    uv[s * 2 + 1] = q[t * 6 + 1] * w + q[t * 6 + 3] * u + q[t * 6 + 5] * v;
    mat[s] = triMat[t];
    tri[s] = t;
  }
  return { count: n, pos, nrm, rowdir, coldir, sid, uv, mat, tri, area };
}

// Yuksel, "Sample Elimination for Generating Poisson Disk Sample Sets" (2015)
function eliminate(cpos: Float32Array, M: number, N: number, area: number, onProgress?: (f: number) => void): Uint32Array {
  const rmax = Math.sqrt(area / (2 * Math.sqrt(3) * N));
  const r2 = 2 * rmax;
  const rmin = rmax * (1 - Math.pow(N / M, 1.5)) * 0.65;
  const r2sq = r2 * r2;
  let ox = Infinity, oy = Infinity, oz = Infinity;
  for (let i = 0; i < M; i++) {
    ox = Math.min(ox, cpos[i * 3]); oy = Math.min(oy, cpos[i * 3 + 1]); oz = Math.min(oz, cpos[i * 3 + 2]);
  }
  ox -= r2; oy -= r2; oz -= r2;
  const grid = buildHashGrid(cpos, M, r2, [ox, oy, oz], nextPow2(M));
  const { start, order, mask } = grid;
  // 点ごとのセル座標。バケットの中で別のセルの点(ハッシュ衝突)と、同じバケットの二度引きを除く
  const cell = new Int32Array(M * 3);
  for (let i = 0; i < M; i++) {
    cell[i * 3] = Math.floor((cpos[i * 3] - ox) / r2);
    cell[i * 3 + 1] = Math.floor((cpos[i * 3 + 1] - oy) / r2);
    cell[i * 3 + 2] = Math.floor((cpos[i * 3 + 2] - oz) / r2);
  }
  const wfun = (d2: number) => {
    let d = Math.sqrt(d2);
    if (d < rmin) d = rmin;
    const x = 1 - d / r2;
    const x2 = x * x, x4 = x2 * x2;
    return x4 * x4;
  };
  // i から r2 以内の点を nb / nd2 に集める
  let nb = new Int32Array(256), nd2 = new Float64Array(256);
  const gather = (i: number): number => {
    const x = cpos[i * 3], y = cpos[i * 3 + 1], z = cpos[i * 3 + 2];
    const cx = cell[i * 3], cy = cell[i * 3 + 1], cz = cell[i * 3 + 2];
    let n = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const qx = cx + dx, qy = cy + dy, qz = cz + dz;
      const h = cellHash(qx, qy, qz, mask);
      for (let k = start[h], e = start[h + 1]; k < e; k++) {
        const j = order[k];
        if (j === i || cell[j * 3] !== qx || cell[j * 3 + 1] !== qy || cell[j * 3 + 2] !== qz) continue;
        const ex = cpos[j * 3] - x, ey = cpos[j * 3 + 1] - y, ez = cpos[j * 3 + 2] - z;
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 >= r2sq) continue;
        if (n === nb.length) {
          const b = new Int32Array(n * 2); b.set(nb); nb = b;
          const c = new Float64Array(n * 2); c.set(nd2); nd2 = c;
        }
        nb[n] = j; nd2[n] = d2; n++;
      }
    }
    return n;
  };

  const W = new Float64Array(M);
  const everyW = Math.max(1, Math.floor(M / 50));
  for (let i = 0; i < M; i++) {
    if (i % everyW === 0) onProgress?.(0.4 * (i / M));
    const n = gather(i);
    let s = 0;
    for (let k = 0; k < n; k++) s += wfun(nd2[k]);
    W[i] = s;
  }

  // 最大ヒープ
  const heap = new Int32Array(M);
  const hpos = new Int32Array(M);
  for (let i = 0; i < M; i++) { heap[i] = i; hpos[i] = i; }
  let hn = M;
  const down = (k: number) => {
    const item = heap[k], w = W[item];
    for (;;) {
      const l = 2 * k + 1;
      if (l >= hn) break;
      const r = l + 1;
      const c = r < hn && W[heap[r]] > W[heap[l]] ? r : l;
      if (W[heap[c]] <= w) break;
      heap[k] = heap[c]; hpos[heap[k]] = k; k = c;
    }
    heap[k] = item; hpos[item] = k;
  };
  for (let k = (hn >> 1) - 1; k >= 0; k--) down(k);

  const alive = new Uint8Array(M).fill(1);
  const toRemove = M - N;
  const every = Math.max(1, Math.floor(toRemove / 50));
  while (hn > N) {
    if ((M - hn) % every === 0) onProgress?.(0.4 + 0.6 * ((M - hn) / toRemove));
    const i = heap[0];
    hn--;
    heap[0] = heap[hn]; hpos[heap[0]] = 0;
    if (hn > 0) down(0);
    alive[i] = 0;
    const n = gather(i);
    for (let k = 0; k < n; k++) {
      const j = nb[k];
      if (!alive[j]) continue;
      W[j] -= wfun(nd2[k]);
      down(hpos[j]);
    }
  }
  const keep = new Uint32Array(N);
  let k = 0;
  for (let i = 0; i < M; i++) if (alive[i]) keep[k++] = i;
  return keep;
}
