// 検証: 出力された実データ(読み戻したテクスチャと散布済みの鱗)を計測する。
// 生成式を再計算するのではなく、GPU が書いた画素を読んで確かめる。
import type { Surface } from './core/surface';
import { mulberry32, type Scales } from './core/scatter';
import { buildHashGrid, forNeighbors, nextPow2 } from './core/hashgrid';
import { sampleUV, type SourceImage } from './core/colorsource';

export interface VerifyReport {
  material: string;
  islandPixels: number;
  holePixels: number;          // 島の中で被覆 < 0.99 の画素
  holeRatio: number;
  seamEdges: number;
  seamSamples: number;
  seamSidMatch: number;        // UV の切れ目の両側で一番上の鱗が同じ割合
  interiorSidMatch: number;    // 比較用: 切れ目でない辺の両側で同じ割合
  seamWorldGapMean: number;    // 両側の画素のワールド距離の平均 [m]
  scaleCount: number;
  nnMean: number;              // 鱗の中心の最近傍距離(平均 / 最小)[m]
  nnMin: number;
}

export function verify(
  s: Surface, matIndex: number, aux: Float32Array, pos: Float32Array, res: number, sc: Scales,
): VerifyReport {
  // --- 1. 穴 ---
  let island = 0, holes = 0;
  for (let i = 0; i < res * res; i++) {
    if (pos[i * 4 + 3] < 0.5) continue;
    island++;
    if (aux[i * 4 + 2] < 0.99) holes++;
  }

  // --- 2. UV の切れ目の連続性 ---
  const edges = new Map<string, { t: number; a: number; b: number }[]>();
  for (let t = 0; t < s.triMat.length; t++) {
    if (s.triMat[t] !== matIndex) continue;
    for (let c = 0; c < 3; c++) {
      const a = c, b = (c + 1) % 3;
      const va = s.tris[t * 3 + a], vb = s.tris[t * 3 + b];
      const key = va < vb ? `${va}_${vb}` : `${vb}_${va}`;
      let l = edges.get(key);
      if (!l) { l = []; edges.set(key, l); }
      l.push({ t, a, b });
    }
  }
  const uvOf = (t: number, c: number) => [s.triUV[t * 6 + c * 2], s.triUV[t * 6 + c * 2 + 1]];
  // 辺上の点(頂点 va→vb の比 k)を、三角形 t の UV で内側へ 1.5 画素ずらした画素
  const sample = (e: { t: number; a: number; b: number }, va: number, k: number): number => {
    const t = e.t;
    const ca = s.tris[t * 3 + e.a] === va ? e.a : e.b;
    const cb = ca === e.a ? e.b : e.a;
    const cc = 3 - e.a - e.b;
    const ua = uvOf(t, ca), ub = uvOf(t, cb), uc = uvOf(t, cc);
    const u = ua[0] + (ub[0] - ua[0]) * k, v = ua[1] + (ub[1] - ua[1]) * k;
    let dx = uc[0] - u, dy = uc[1] - v;
    const dl = Math.hypot(dx, dy) || 1;
    dx = (dx / dl) * 1.5 / res; dy = (dy / dl) * 1.5 / res;
    const px = Math.min(res - 1, Math.max(0, Math.floor((u + dx) * res)));
    const py = Math.min(res - 1, Math.max(0, Math.floor((v + dy) * res)));
    return py * res + px;
  };
  let seamEdges = 0, seamN = 0, seamMatch = 0, gapSum = 0, intN = 0, intMatch = 0;
  for (const [key, l] of edges) {
    if (l.length !== 2) continue;
    const va = Number(key.split('_')[0]);
    const [e0, e1] = l;
    const vb = Number(key.split('_')[1]);
    const uv0a = uvOf(e0.t, s.tris[e0.t * 3 + e0.a] === va ? e0.a : e0.b);
    const uv1a = uvOf(e1.t, s.tris[e1.t * 3 + e1.a] === va ? e1.a : e1.b);
    const uv0b = uvOf(e0.t, s.tris[e0.t * 3 + e0.a] === vb ? e0.a : e0.b);
    const uv1b = uvOf(e1.t, s.tris[e1.t * 3 + e1.a] === vb ? e1.a : e1.b);
    const isSeam = Math.hypot(uv0a[0] - uv1a[0], uv0a[1] - uv1a[1]) > 1e-5 || Math.hypot(uv0b[0] - uv1b[0], uv0b[1] - uv1b[1]) > 1e-5;
    // UV 上の辺の長さが 6 画素未満の辺は、内側へずらすと辺から外れやすいので数えない
    const lenPx = Math.hypot(uv0a[0] - uv0b[0], uv0a[1] - uv0b[1]) * res;
    if (lenPx < 6) continue;
    if (isSeam) seamEdges++;
    for (let k = 0.15; k < 0.9; k += 0.1) {
      const p0 = sample(e0, va, k), p1 = sample(e1, va, k);
      if (aux[p0 * 4 + 2] < 0.99 || aux[p1 * 4 + 2] < 0.99) continue;
      const same = aux[p0 * 4 + 1] === aux[p1 * 4 + 1] ? 1 : 0;
      if (isSeam) {
        seamN++; seamMatch += same;
        gapSum += Math.hypot(pos[p0 * 4] - pos[p1 * 4], pos[p0 * 4 + 1] - pos[p1 * 4 + 1], pos[p0 * 4 + 2] - pos[p1 * 4 + 2]);
      } else { intN++; intMatch += same; }
    }
  }

  // --- 3. 鱗の間隔 ---
  const nn = nearestNeighbor(sc);

  return {
    material: s.materials[matIndex],
    islandPixels: island, holePixels: holes, holeRatio: island ? holes / island : 0,
    seamEdges, seamSamples: seamN,
    seamSidMatch: seamN ? seamMatch / seamN : NaN,
    interiorSidMatch: intN ? intMatch / intN : NaN,
    seamWorldGapMean: seamN ? gapSum / seamN : NaN,
    scaleCount: sc.count, nnMean: nn.mean, nnMin: nn.min,
  };
}

function nearestNeighbor(sc: Scales): { mean: number; min: number } {
  const r = Math.sqrt(sc.area / sc.count) * 2;
  let ox = Infinity, oy = Infinity, oz = Infinity;
  for (let i = 0; i < sc.count; i++) { ox = Math.min(ox, sc.pos[i * 3]); oy = Math.min(oy, sc.pos[i * 3 + 1]); oz = Math.min(oz, sc.pos[i * 3 + 2]); }
  const g = buildHashGrid(sc.pos, sc.count, r, [ox - r, oy - r, oz - r], nextPow2(sc.count));
  let sum = 0, n = 0, mn = Infinity;
  for (let i = 0; i < sc.count; i++) {
    const x = sc.pos[i * 3], y = sc.pos[i * 3 + 1], z = sc.pos[i * 3 + 2];
    let best = Infinity;
    forNeighbors(g, x, y, z, (j) => {
      if (j === i) return;
      const d = Math.hypot(sc.pos[j * 3] - x, sc.pos[j * 3 + 1] - y, sc.pos[j * 3 + 2] - z);
      if (d < best) best = d;
    });
    if (best < Infinity) { sum += best; n++; mn = Math.min(mn, best); }
  }
  return { mean: n ? sum / n : NaN, min: mn };
}

// 「テクスチャから」の検証: 出力の各画素の色味が、一番上の鱗の「中心の位置」の元の色と一致するか。
// 比較用に「その画素自身の位置」の元の色とも照合する。両者の色味が違う画素だけを数える
// (明るさ・色味の差・まだらを 0 にした状態で測ること。溝と AO は明るさだけを変える)。
export interface ColorVerifyReport {
  material: number;
  pixels: number;              // 判定に使った画素(島内・被覆 1・両者の色味が違う)
  matchCenter: number;         // 出力の色味が中心の色と一致した割合
  matchPixel: number;          // 出力の色味が画素自身の位置の色と一致した割合
  scalesChecked: number;
  scaleChromaSpreadMax: number; // 鱗 1 枚の中での色味のばらつき(最大、L1)
}

export function verifyScaleColors(
  sc: Scales, img: SourceImage, matIndex: number, color: Uint8Array, aux: Float32Array, pos: Float32Array, res: number,
): ColorVerifyReport {
  // 画素 → 鱗の対応は aux の乱数値で引く。乱数は 32bit float なので 2 万枚で数組は同じ値になる
  // (描画は番号で引くので影響しない)。同じ値の鱗は区別できないので検証から外す
  const bySid = new Map<number, number>();
  const dupSid = new Set<number>();
  for (let i = 0; i < sc.count; i++) {
    if (bySid.has(sc.sid[i])) dupSid.add(sc.sid[i]);
    bySid.set(sc.sid[i], i);
  }
  for (const d of dupSid) bySid.delete(d);
  const chroma = (r: number, g: number, b: number): [number, number, number] => {
    const s = r + g + b || 1;
    return [r / s, g / s, b / s];
  };
  const dist = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const centerChroma = new Map<number, [number, number, number]>();
  const spread = new Map<number, { min: number[]; max: number[] }>();
  let n = 0, mc = 0, mp = 0;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const p = y * res + x;
      if (pos[p * 4 + 3] < 0.5 || aux[p * 4 + 2] < 0.999) continue;
      const i = bySid.get(aux[p * 4 + 1]);
      if (i === undefined || sc.mat[i] !== matIndex) continue;
      let cc = centerChroma.get(i);
      if (!cc) { cc = chroma(...sampleUV(img, sc.uv[i * 2], sc.uv[i * 2 + 1])); centerChroma.set(i, cc); }
      const oc = chroma(color[p * 4], color[p * 4 + 1], color[p * 4 + 2]);
      let sp = spread.get(i);
      if (!sp) { sp = { min: [...oc], max: [...oc] }; spread.set(i, sp); }
      for (let k = 0; k < 3; k++) { sp.min[k] = Math.min(sp.min[k], oc[k]); sp.max[k] = Math.max(sp.max[k], oc[k]); }
      const pc = chroma(...sampleUV(img, (x + 0.5) / res, (y + 0.5) / res));
      if (dist(cc, pc) < 0.1) continue;
      n++;
      if (dist(oc, cc) < 0.03) mc++;
      if (dist(oc, pc) < 0.03) mp++;
    }
  }
  let spreadMax = 0;
  for (const s of spread.values()) spreadMax = Math.max(spreadMax, dist(s.min, s.max));
  return {
    material: matIndex, pixels: n, matchCenter: n ? mc / n : NaN, matchPixel: n ? mp / n : NaN,
    scalesChecked: spread.size, scaleChromaSpreadMax: spreadMax,
  };
}

// 鱗の中心の並びの均一さ(Houdini の緩和と比べるための指標)。すべて間隔 d0 = √(面積 / 枚数) で割った値。
//   最近傍距離: 平均・変動係数・1% 点・最小(均一なほど平均が大きく、変動係数が小さい)
//   隙間: 面上の一様な点から最寄りの中心までの距離の 99% 点・最大(大きいと鱗の穴になりやすい)
export interface PlacementStats { n: number; nnMean: number; nnCV: number; nnP1: number; nnMin: number; gapP99: number; gapMax: number }

export function placementStats(s: Surface, matMask: boolean[], pos: Float32Array, area: number, samples = 200000): PlacementStats {
  const n = pos.length / 3, d0 = Math.sqrt(area / n);
  const g = buildHashGrid(pos, n, d0 * 2.5, [-10, -10, -10], nextPow2(n));
  const nearest = (x: number, y: number, z: number, skip: number) => {
    let b = Infinity;
    forNeighbors(g, x, y, z, (j) => {
      if (j === skip) return;
      const d = Math.hypot(pos[j * 3] - x, pos[j * 3 + 1] - y, pos[j * 3 + 2] - z);
      if (d < b) b = d;
    });
    return b / d0;
  };
  const nn: number[] = [];
  for (let i = 0; i < n; i++) { const d = nearest(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], i); if (d < Infinity) nn.push(d); }
  nn.sort((a, b) => a - b);
  const mean = nn.reduce((a, b) => a + b, 0) / nn.length;
  const sd = Math.sqrt(nn.reduce((a, b) => a + (b - mean) ** 2, 0) / nn.length);

  // 面上の一様な点(乱数の種は固定: 比べる配置どうしで同じ点を使う)
  const P = s.positions, T = s.tris, rng = mulberry32(12345);
  const tl: number[] = [], cdf: number[] = [];
  let acc = 0;
  for (let t = 0; t < s.triMat.length; t++) {
    if (!matMask[s.triMat[t]]) continue;
    const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    acc += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    tl.push(t); cdf.push(acc);
  }
  const gap: number[] = [];
  for (let k = 0; k < samples; k++) {
    const r = rng() * acc;
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < r) lo = m + 1; else hi = m; }
    const t = tl[lo];
    let u = rng(), v = rng();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
    const w = 1 - u - v;
    gap.push(nearest(P[a * 3] * w + P[b * 3] * u + P[c * 3] * v, P[a * 3 + 1] * w + P[b * 3 + 1] * u + P[c * 3 + 1] * v, P[a * 3 + 2] * w + P[b * 3 + 2] * u + P[c * 3 + 2] * v, -1));
  }
  gap.sort((a, b) => a - b);
  const q = (arr: number[], p: number) => +arr[Math.min(arr.length - 1, Math.floor(arr.length * p))].toFixed(3);
  return {
    n, nnMean: +mean.toFixed(3), nnCV: +(sd / mean).toFixed(3), nnP1: q(nn, 0.01), nnMin: +nn[0].toFixed(3),
    gapP99: q(gap, 0.99), gapMax: +gap[gap.length - 1].toFixed(3),
  };
}
