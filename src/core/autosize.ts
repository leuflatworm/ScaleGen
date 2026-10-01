// 細い所で鱗を自動で小さくする(自動サイズ)。
//   1. 面の上にサンプル点を撒く。間隔は鱗の大きさで決め、メッシュの細かさ(辺の長さ)には依らない。
//   2. サンプル点ごとに「面に沿った流れの向き」を法線とする平面でモデルを切り、その点を通る断面の輪の長さ(周長)を測る。
//      上限の倍率 = 周長 / (6 × 鱗の大きさ)(実際は 5% の余裕を見る)。鱗がこれより大きいと一周に 6 枚並ばない。
//   3. サンプル点どうしを空間の距離でぼかす。ぼかすたびに上限で切るので、細い側の値は上がらず、
//      太い側だけが細い側へ向けてなだらかに小さくなる(ぼかしたあとも上限を超えない)。
// 平面の法線は面に沿った流れの向きなので、指先のような丸い端でも断面は指の太さの輪になり、端だけ極端に小さくはならない。
// 鱗の候補点の倍率は、近くのサンプル点から補間して読む(sizefield.ts の autoSizeLookup)。
import { buildHashGrid, forNeighbors, nextPow2 } from './hashgrid';
import { mulberry32 } from './scatter';
import type { AutoSizeField } from './sizefield';

export const AUTO_AROUND = 6;      // 一周に最低これだけ鱗が並ぶようにする
export const AUTO_MIN = 0.2;       // 自動で小さくする下限(枚数が増えすぎないように)
// 上限に持たせる余裕。倍率はサンプル点で決め、鱗は配置後の押し広げで少し動くので、余裕が無いと
// ごく一部の鱗が 6 枚を割る(実測 Akyo 20〜60mm: 余裕無しで最小 5.83 枚 = 不足 3%)
const AUTO_MARGIN = 1.05;
// 以下はどれも「鱗の大きさの何倍か」。メッシュの辺の長さは使わない
const SAMPLE_STEP = 0.75;          // サンプル点の間隔
const BLUR_KERNEL = 2;             // ぼかし 1 回で混ぜる半径
const BLUR_ITER = 16;              // ぼかしの回数。広がる距離(2 乗平均)= BLUR_KERNEL / 2 × √回数 = 鱗 4 枚ぶん
const INTERP_RADIUS = 1.5;         // 候補点が倍率を読むときに見る半径(この中のサンプル点の最小を使う)
const MAX_SAMPLES = 1_500_000;     // サンプル点の上限(これを超えるときは間隔を広げる)

// 三角形の辺ごとの隣の三角形(辺 k = 頂点 k と k+1 の間)。無ければ -1。3 枚以上が集まる辺は最初の 2 枚だけつなぐ
export function triangleNeighbors(nv: number, tris: Uint32Array): Int32Array {
  const nt = tris.length / 3;
  const nbr = new Int32Array(nt * 3).fill(-1);
  const first = new Map<number, number>();   // 辺 → 三角形*3 + 辺番号
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const a = tris[t * 3 + k], b = tris[t * 3 + (k + 1) % 3];
      if (a === b) continue;
      const key = a < b ? a * nv + b : b * nv + a;
      const o = first.get(key);
      if (o === undefined) { first.set(key, t * 3 + k); continue; }
      if (o < 0) continue;   // すでに 2 枚つないだ辺
      nbr[t * 3 + k] = Math.floor(o / 3);
      nbr[o] = t;
      first.set(key, -1);
    }
  }
  return nbr;
}

// 面の上の 1 点(三角形 t0 の中の点 p)を通る、法線 n の平面での断面の周長。
// 隣の三角形へ渡りながら平面との交線をたどり、t0 に戻ったら輪が閉じたとみなす。
// 輪が閉じずにメッシュの縁で終わる断面(開いた面)は、裏表を一周するとみなして長さの 2 倍にする。
// 断面が取れなければ NaN。長さが cap を超えたら打ち切って Infinity(それ以上は「十分太い」としか使わない)。
export function sectionPerimeterAt(
  P: Float32Array, tris: Uint32Array, nbr: Int32Array, t0: number,
  px: number, py: number, pz: number, nx: number, ny: number, nz: number, cap = Infinity,
): number {
  const dist = (i: number) => (P[i * 3] - px) * nx + (P[i * 3 + 1] - py) * ny + (P[i * 3 + 2] - pz) * nz;
  // t0 の中で平面が横切る 2 辺
  const edges: number[] = [];
  for (let k = 0; k < 3; k++) {
    if ((dist(tris[t0 * 3 + k]) >= 0) !== (dist(tris[t0 * 3 + (k + 1) % 3]) >= 0)) edges.push(k);
  }
  if (edges.length !== 2) return NaN;
  const cross = (a: number, b: number, da: number, db: number): [number, number, number] => {
    const f = da / (da - db);
    return [P[a * 3] + (P[b * 3] - P[a * 3]) * f, P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * f, P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * f];
  };
  const starts = edges.map((k) => {
    const a = tris[t0 * 3 + k], b = tris[t0 * 3 + (k + 1) % 3];
    return { k, a, b, da: dist(a), db: dist(b), x: cross(a, b, dist(a), dist(b)) };
  });
  let total = Math.hypot(starts[0].x[0] - starts[1].x[0], starts[0].x[1] - starts[1].x[1], starts[0].x[2] - starts[1].x[2]);
  let closed = false;
  const maxSteps = tris.length / 3 + 8;
  for (const st of starts) {
    let ea = st.a, eb = st.b, da = st.da, db = st.db;
    let [x, y, z] = st.x;
    let cur = nbr[t0 * 3 + st.k];
    for (let step = 0; step < maxSteps && cur >= 0; step++) {
      if (cur === t0) { closed = true; break; }   // 反対側の辺から t0 に戻った = 輪が閉じた
      const a = tris[cur * 3], b = tris[cur * 3 + 1], c0 = tris[cur * 3 + 2];
      const c = a !== ea && a !== eb ? a : b !== ea && b !== eb ? b : c0;
      if (c === ea || c === eb) break;             // つぶれた三角形
      const dc = dist(c);
      if ((dc >= 0) === (da >= 0)) { ea = c; da = dc; } else { eb = c; db = dc; }
      const [x2, y2, z2] = cross(ea, eb, da, db);
      total += Math.hypot(x2 - x, y2 - y, z2 - z);
      if (total > cap) return Infinity;
      x = x2; y = y2; z = z2;
      // 次に渡る辺(ea, eb)の向こうの三角形
      let next = -1;
      for (let k = 0; k < 3; k++) {
        const u = tris[cur * 3 + k], w = tris[cur * 3 + (k + 1) % 3];
        if ((u === ea && w === eb) || (u === eb && w === ea)) { next = nbr[cur * 3 + k]; break; }
      }
      cur = next;
    }
    if (closed) break;
  }
  return closed ? total : 2 * total;
}

export interface AutoSizeInput {
  positions: Float32Array;
  normals: Float32Array;
  tris: Uint32Array;
  triMat: Uint16Array;
  flow: Float32Array;       // 頂点ごとの進行方向
  matMask: boolean[];       // 鱗を撒くマテリアル(サンプル点はここにだけ撒く。断面はモデル全体で測る)
  spacing: number;          // 鱗の大きさ [positions と同じ単位]
  nbr: Int32Array;          // triangleNeighbors の結果(モデルが同じ間は使い回せる)
}

// サンプル点ごとの倍率。tri / bar はサンプル点が乗っている三角形と重心座標(枚数の見込みで UV を引くため)
export interface AutoSizeSamples extends AutoSizeField {
  tri: Uint32Array;
  bar: Float32Array;       // N*2 (u, v)
  limit: Float32Array;     // ぼかす前の上限(検証用)
  areaPer: number;         // サンプル点 1 つが受け持つ面積
}

// 小さくする所が 1 つも無ければ null(自動サイズ無しと同じ結果になる)
export function buildAutoSizeField(inp: AutoSizeInput): AutoSizeSamples | null {
  const { positions: P, normals: Nv, tris, triMat, flow, spacing, nbr } = inp;
  // --- 1. サンプル点を撒く(三角形ごとに 面積 / 間隔² 個。端数は乱数で切り上げ・切り捨て) ---
  const nt = triMat.length;
  const triArea = new Float32Array(nt);
  let area = 0;
  for (let t = 0; t < nt; t++) {
    if (!inp.matMask[triMat[t]]) continue;
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    triArea[t] = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    area += triArea[t];
  }
  if (!(area > 0)) return null;
  const step = Math.max(SAMPLE_STEP * spacing, Math.sqrt(area / MAX_SAMPLES));
  const rng = mulberry32(90001);
  const stri: number[] = [], sbar: number[] = [];
  for (let t = 0; t < nt; t++) {
    if (triArea[t] === 0) continue;
    const e = triArea[t] / (step * step);
    const n = Math.floor(e) + (rng() < e - Math.floor(e) ? 1 : 0);
    for (let i = 0; i < n; i++) {
      let u = rng(), v = rng();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      stri.push(t); sbar.push(u, v);
    }
  }
  const ns = stri.length;
  if (ns === 0) return null;

  // --- 2. 断面の周長から上限の倍率を決める ---
  const pos = new Float32Array(ns * 3), limit = new Float32Array(ns);
  const cap = AUTO_AROUND * AUTO_MARGIN * spacing;   // これより長い断面は「十分太い」= 1
  let lmin = 1;
  for (let i = 0; i < ns; i++) {
    const t = stri[i], u = sbar[i * 2], v = sbar[i * 2 + 1], w = 1 - u - v;
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    const px = P[a * 3] * w + P[b * 3] * u + P[c * 3] * v;
    const py = P[a * 3 + 1] * w + P[b * 3 + 1] * u + P[c * 3 + 1] * v;
    const pz = P[a * 3 + 2] * w + P[b * 3 + 2] * u + P[c * 3 + 2] * v;
    pos[i * 3] = px; pos[i * 3 + 1] = py; pos[i * 3 + 2] = pz;
    // 平面の法線 = 面に沿った流れの向き(鱗の向きの決め方と同じ: 補間した流れから法線の成分を除く)
    let mx = Nv[a * 3] * w + Nv[b * 3] * u + Nv[c * 3] * v;
    let my = Nv[a * 3 + 1] * w + Nv[b * 3 + 1] * u + Nv[c * 3 + 1] * v;
    let mz = Nv[a * 3 + 2] * w + Nv[b * 3 + 2] * u + Nv[c * 3 + 2] * v;
    const ml = Math.hypot(mx, my, mz) || 1;
    mx /= ml; my /= ml; mz /= ml;
    let nx = flow[a * 3] * w + flow[b * 3] * u + flow[c * 3] * v;
    let ny = flow[a * 3 + 1] * w + flow[b * 3 + 1] * u + flow[c * 3 + 1] * v;
    let nz = flow[a * 3 + 2] * w + flow[b * 3 + 2] * u + flow[c * 3 + 2] * v;
    const dn = nx * mx + ny * my + nz * mz;
    nx -= mx * dn; ny -= my * dn; nz -= mz * dn;
    const nl = Math.hypot(nx, ny, nz);
    limit[i] = 1;
    if (!(nl > 1e-6)) continue;   // 流れが決まらない点は小さくしない
    const perim = sectionPerimeterAt(P, tris, nbr, t, px, py, pz, nx / nl, ny / nl, nz / nl, cap);
    const lim = perim / cap;       // 断面が取れない点(NaN)は比較が偽になり 1 のまま
    if (lim < 1) limit[i] = Math.max(AUTO_MIN, lim);
    if (limit[i] < lmin) lmin = limit[i];
  }
  if (lmin >= 1) return null;

  // --- 3. 上限を超えない範囲でぼかす ---
  // 近くのサンプル点の重み付き平均(重み (1 - d²/r²)²)を取り、そのつど上限で切る。
  // 値が変わりうるのは「1 未満の点とその近く」だけなので、そこだけ計算する
  const r = Math.max(BLUR_KERNEL * spacing, 2.5 * step);
  const r2 = r * r;
  let ox = Infinity, oy = Infinity, oz = Infinity;
  for (let i = 0; i < ns; i++) { ox = Math.min(ox, pos[i * 3]); oy = Math.min(oy, pos[i * 3 + 1]); oz = Math.min(oz, pos[i * 3 + 2]); }
  const grid = buildHashGrid(pos, ns, r, [ox - r, oy - r, oz - r], nextPow2(ns));
  let s = limit.slice(), next = new Float32Array(ns);
  const active = new Uint8Array(ns);
  for (let it = 0; it < BLUR_ITER; it++) {
    active.fill(0);
    for (let i = 0; i < ns; i++) {
      if (s[i] >= 1) continue;
      forNeighbors(grid, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], (j) => { active[j] = 1; });
    }
    for (let i = 0; i < ns; i++) {
      if (!active[i]) { next[i] = s[i]; continue; }
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      let acc = 0, wsum = 0;
      forNeighbors(grid, x, y, z, (j) => {
        const dx = pos[j * 3] - x, dy = pos[j * 3 + 1] - y, dz = pos[j * 3 + 2] - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r2) return;
        const q = 1 - d2 / r2, wt = q * q;
        acc += wt * s[j]; wsum += wt;
      });
      next[i] = Math.min(limit[i], acc / wsum);   // 自分自身(重み 1)が必ず入るので wsum > 0
    }
    const tmp = s; s = next; next = tmp;
  }
  let min = 1;
  for (let i = 0; i < ns; i++) min = Math.min(min, s[i]);
  return {
    pos, val: s, radius: Math.max(INTERP_RADIUS * spacing, 2 * step), min,
    tri: new Uint32Array(stri), bar: new Float32Array(sbar), limit, areaPer: area / ns,
  };
}
