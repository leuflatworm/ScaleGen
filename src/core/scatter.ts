// 面上に鱗の中心を撒き、1 枚ごとの向き・乱数を決める。
// Houdini 版は scatter + 緩和 400 回。ここではサンプル間引き法(Yuksel 2015)で
// 候補を多めに撒いてから重み付きで間引き、1 パスで青色ノイズ的な分布を得る。
import { buildHashGrid, cellHash, nextPow2 } from './hashgrid';
import { tangentDir } from './flow';
import { relaxOnSurface } from './relax';
import { hasSizeField, sizeAt, sizeRange, type SizeFieldInput } from './sizefield';

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
  size?: SizeFieldInput | null; // 場所ごとの鱗の大きさ(サイズマップ)。無ければどこでも 1
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
  ssz: Float32Array;     // N   鱗ごとの大きさの倍率(サイズマップ。無ければ 1)
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
  // 面積に比例して三角形と重心座標を 1 つ選ぶ
  const pick = (rand: () => number): [number, number, number] => {
    const r = rand() * area;
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; }
    const t = tlist[lo];
    let u = rand(), v = rand();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    return [t, u, v];
  };
  const field = hasSizeField(inp.size) ? inp.size : null;
  // 三角形 t の重心座標 (u, v) での大きさの倍率
  const sizeOf = (t: number, u: number, v: number) => {
    const q = inp.triUV, w = 1 - u - v;
    return sizeAt(field!, triMat[t], q[t * 6] * w + q[t * 6 + 2] * u + q[t * 6 + 4] * v, q[t * 6 + 1] * w + q[t * 6 + 3] * u + q[t * 6 + 5] * v);
  };

  let N: number, M: number;
  let cpos: Float32Array, ctri: Uint32Array, cbar: Float32Array;
  let csize: Float32Array | undefined;
  if (!field) {
    N = Math.max(1, Math.round(area / (inp.spacing * inp.spacing)));
    // 候補の倍率。論文の既定は 5 倍だが、3 倍でも最近傍距離の分布はほぼ同じで 2.5 倍速い
    // (実測 10 万枚: 5 倍 4.6 秒 / 3 倍 1.8 秒、最近傍距離 1% 点 0.685 → 0.655 × 間隔)
    M = N * 3;

    // --- 候補を撒く ---
    cpos = new Float32Array(M * 3);
    ctri = new Uint32Array(M);
    cbar = new Float32Array(M * 2);
    for (let i = 0; i < M; i++) {
      const [t, u, v] = pick(rng);
      const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
      for (let k = 0; k < 3; k++) {
        cpos[i * 3 + k] = P[a * 3 + k] * (1 - u - v) + P[b * 3 + k] * u + P[c * 3 + k] * v;
      }
      ctri[i] = t; cbar[i * 2] = u; cbar[i * 2 + 1] = v;
    }
  } else {
    // --- サイズマップあり: 密度 1/s² で撒く ---
    // 枚数 = ∫ 1/(間隔 × s)² dA。面上の一様な点で 1/s² の平均を見積もる(乱数は配置と別の系列)
    const est = mulberry32(inp.seed * 6151 + 29);
    const K = 20000;
    let accW = 0;
    for (let k = 0; k < K; k++) { const [t, u, v] = pick(est); const s = sizeOf(t, u, v); accW += 1 / (s * s); }
    N = Math.max(1, Math.round((area / (inp.spacing * inp.spacing)) * (accW / K)));
    M = N * 3;
    // 一様に撒いた点を、1/s² に比例する確率で受け入れる(小さい鱗の所ほど多く残る)
    const smin = sizeRange(field).min;
    const wmax = 1 / (smin * smin);
    cpos = new Float32Array(M * 3); ctri = new Uint32Array(M); cbar = new Float32Array(M * 2); csize = new Float32Array(M);
    let i = 0;
    for (let tries = 0; i < M && tries < M * wmax * 8 + 1000; tries++) {
      const [t, u, v] = pick(rng);
      const s = sizeOf(t, u, v);
      if (rng() * wmax > 1 / (s * s)) continue;
      const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
      for (let k = 0; k < 3; k++) {
        cpos[i * 3 + k] = P[a * 3 + k] * (1 - u - v) + P[b * 3 + k] * u + P[c * 3 + k] * v;
      }
      ctri[i] = t; cbar[i * 2] = u; cbar[i * 2 + 1] = v; csize[i] = s;
      i++;
    }
    M = i;
    N = Math.min(N, M);
  }

  // 鱗の間隔 d0: サイズマップ無しは従来どおり √(面積/枚数)、ありは指定の間隔(局所の間隔 = d0 × s)
  const keep = field
    ? eliminate(cpos, M, N, area, (f) => onProgress?.('eliminate', f), csize, inp.spacing / Math.sqrt(2 * Math.sqrt(3)))
    : eliminate(cpos, M, N, area, (f) => onProgress?.('eliminate', f));

  // --- 面の上で押し広げる ---
  const n = keep.length;
  const kpos = new Float32Array(n * 3), ktri = new Uint32Array(n), kbar = new Float32Array(n * 2);
  const ksize = csize ? new Float32Array(n) : undefined;
  for (let s = 0; s < n; s++) {
    const i = keep[s];
    kpos.set(cpos.subarray(i * 3, i * 3 + 3), s * 3);
    ktri[s] = ctri[i]; kbar[s * 2] = cbar[i * 2]; kbar[s * 2 + 1] = cbar[i * 2 + 1];
    if (ksize && csize) ksize[s] = csize[i];
  }
  relaxOnSurface({
    positions: P, tris, triMat, matMask: inp.matMask, spacing: field ? inp.spacing : Math.sqrt(area / n),
    iterations: inp.relaxIterations ?? RELAX_ITERATIONS, sizes: ksize,
  }, n, kpos, ktri, kbar, (f) => onProgress?.('relax', f));

  // --- 1 枚ごとの属性 ---
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
  const rowdir = new Float32Array(n * 3), coldir = new Float32Array(n * 3), sid = new Float32Array(n);
  const uv = new Float32Array(n * 2), mat = new Uint16Array(n), tri = new Uint32Array(n);
  const ssz = new Float32Array(n).fill(1);
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
    // 大きさは配置したときの値を持ち続ける。押し広げ後の位置で読み直すと、小さい鱗の間隔で並んだ点が
    // 継ぎ目を越えて「大きい鱗」になり、境目に大きい鱗が密集して互いを隠す
    // (実測: 境目の大きい鱗どうしの最近傍 2.22mm / 内側 5.81mm、見える面積 0.62 倍)
    if (ksize) ssz[s] = ksize[s];
  }
  return { count: n, pos, nrm, rowdir, coldir, sid, uv, mat, tri, ssz, area };
}

// Yuksel, "Sample Elimination for Generating Poisson Disk Sample Sets" (2015)
// sizes: 候補ごとの大きさの倍率(サイズマップ)。2 点の間の基準距離を 2 点の倍率の平均で伸縮する。
// 省略時は一様で、従来と同じ計算になる。rmaxBase: 倍率 1 の所の rmax(省略時は面積/枚数から)
function eliminate(
  cpos: Float32Array, M: number, N: number, area: number, onProgress?: (f: number) => void,
  sizes?: Float32Array, rmaxBase?: number,
): Uint32Array {
  const rmax = rmaxBase ?? Math.sqrt(area / (2 * Math.sqrt(3) * N));
  const r2 = 2 * rmax;
  const rmin = rmax * (1 - Math.pow(N / M, 1.5)) * 0.65;
  let smax = 1;
  if (sizes) { smax = 0; for (let i = 0; i < M; i++) smax = Math.max(smax, sizes[i]); }
  const cellR = sizes ? r2 * smax : r2;   // 近傍を集める半径(いちばん大きい鱗に合わせる)
  const r2sq = cellR * cellR;
  let ox = Infinity, oy = Infinity, oz = Infinity;
  for (let i = 0; i < M; i++) {
    ox = Math.min(ox, cpos[i * 3]); oy = Math.min(oy, cpos[i * 3 + 1]); oz = Math.min(oz, cpos[i * 3 + 2]);
  }
  ox -= cellR; oy -= cellR; oz -= cellR;
  const grid = buildHashGrid(cpos, M, cellR, [ox, oy, oz], nextPow2(M));
  const { start, order, mask } = grid;
  // 点ごとのセル座標。バケットの中で別のセルの点(ハッシュ衝突)と、同じバケットの二度引きを除く
  const cell = new Int32Array(M * 3);
  for (let i = 0; i < M; i++) {
    cell[i * 3] = Math.floor((cpos[i * 3] - ox) / cellR);
    cell[i * 3 + 1] = Math.floor((cpos[i * 3 + 1] - oy) / cellR);
    cell[i * 3 + 2] = Math.floor((cpos[i * 3 + 2] - oz) / cellR);
  }
  const wUniform = (d2: number) => {
    let d = Math.sqrt(d2);
    if (d < rmin) d = rmin;
    const x = 1 - d / r2;
    const x2 = x * x, x4 = x2 * x2;
    return x4 * x4;
  };
  const wSized = (d2: number, i: number, j: number) => {
    const sij = (sizes![i] + sizes![j]) * 0.5;
    const rij = r2 * sij;
    if (d2 >= rij * rij) return 0;
    let d = Math.sqrt(d2);
    const rm = rmin * sij;
    if (d < rm) d = rm;
    const x = 1 - d / rij;
    const x2 = x * x, x4 = x2 * x2;
    return x4 * x4;
  };
  const wfun = (d2: number, i: number, j: number) => (sizes ? wSized(d2, i, j) : wUniform(d2));
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
    for (let k = 0; k < n; k++) s += wfun(nd2[k], i, nb[k]);
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
      W[j] -= wfun(nd2[k], i, j);
      down(hpos[j]);
    }
  }
  const keep = new Uint32Array(N);
  let k = 0;
  for (let i = 0; i < M; i++) if (alive[i]) keep[k++] = i;
  return keep;
}
