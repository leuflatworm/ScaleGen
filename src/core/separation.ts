// 離れた部位の鱗を混ぜないための判定(Houdini 版 geo_test / 到達表の置き換え)。
//
// 空間では近いが面をたどると遠い所(隣り合う指の甲どうし、触れ合う腕と胴など)で、
// 片方の鱗がもう片方に描かれるのを防ぐ。法線テストは同じ向きの面どうしを素通りさせるので別に要る。
//
// 判定の単位は「三角形 × 鱗」。画素は自分がどの三角形の上にあるかを焼き込みで正確に知っているので、
// 所属がぶれない(頂点単位だと、辺の長い粗いメッシュで画素とセルの距離が大きく、判定が崩れる)。
//   1. 鱗ごとに、鱗の三角形の角から出発してメッシュの辺をたどる距離(Dijkstra, 上限付き)を求める
//   2. タイルが届く範囲(直線距離 rad 以内)の三角形 T について
//        直線距離 e      = 鱗の中心と T の最短距離
//        面上距離の下限 lb = min(T の角までの距離) - T の最長辺
//      lb > ratio × e なら「面をたどると遠い」ので、その三角形にはその鱗を描かない
//   下限を控えめに取る(角経由の経路は真の測地距離より長くなりうるので最長辺を引く)ことで、
//   同じ面の鱗を誤って捨てにくくしている。鱗の三角形と頂点を共有する三角形は常に許す。
import type { Scales } from './scatter';

export interface SeparationInput {
  positions: Float32Array;
  tris: Uint32Array;
  triMat: Uint16Array;
  matMask: boolean[];
  rad: number;       // タイルが届く最大の直線距離 [m]
  ratio: number;     // 面上距離 / 直線距離 がこれを超えたら別の部位
}

// 戻り値: [三角形, 鱗, 三角形, 鱗, ...] の禁止ペア
export function computeSeparation(inp: SeparationInput, sc: Scales, onProgress?: (f: number) => void): Uint32Array {
  const P = inp.positions, T = inp.tris;
  const nv = P.length / 3, nt = T.length / 3;

  // --- 辺のグラフ(CSR、辺の長さ付き)と三角形の最長辺 ---
  const deg = new Uint32Array(nv + 1);
  for (let t = 0; t < nt; t++) for (let c = 0; c < 3; c++) { deg[T[t * 3 + c] + 1] += 2; }
  for (let i = 0; i < nv; i++) deg[i + 1] += deg[i];
  const fill = deg.slice(0, nv);
  const nbr = new Uint32Array(deg[nv]);
  const len = new Float32Array(deg[nv]);
  const dist3 = (a: number, b: number) =>
    Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
  const triMaxEdge = new Float32Array(nt);
  for (let t = 0; t < nt; t++) {
    let me = 0;
    for (let c = 0; c < 3; c++) {
      const a = T[t * 3 + c], b = T[t * 3 + (c + 1) % 3];
      const l = dist3(a, b);
      me = Math.max(me, l);
      nbr[fill[a]] = b; len[fill[a]++] = l;
      nbr[fill[b]] = a; len[fill[b]++] = l;
    }
    triMaxEdge[t] = me;
  }

  // --- 描かれる側の三角形(選んだマテリアル)を格子に入れる。セル = rad ---
  const cell = inp.rad;
  let ox = Infinity, oy = Infinity, oz = Infinity;
  for (let i = 0; i < nv; i++) { ox = Math.min(ox, P[i * 3]); oy = Math.min(oy, P[i * 3 + 1]); oz = Math.min(oz, P[i * 3 + 2]); }
  ox -= cell; oy -= cell; oz -= cell;
  const cellOf = (x: number, lo: number) => Math.floor((x - lo) / cell);
  const buckets = new Map<number, number[]>();
  // セル座標をそのまま 1 つの数に詰めたキー(衝突なし。大きな三角形は多くのセルに入るので、
  // ハッシュを表の大きさで丸めると衝突でバケットが膨れて遅くなる)
  const bucketKey = (ix: number, iy: number, iz: number) => (ix + 32768) + (iy + 32768) * 65536 + (iz + 32768) * 4294967296;
  for (let t = 0; t < nt; t++) {
    if (!inp.matMask[inp.triMat[t]]) continue;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let c = 0; c < 3; c++) {
      const v = T[t * 3 + c];
      x0 = Math.min(x0, P[v * 3]); y0 = Math.min(y0, P[v * 3 + 1]); z0 = Math.min(z0, P[v * 3 + 2]);
      x1 = Math.max(x1, P[v * 3]); y1 = Math.max(y1, P[v * 3 + 1]); z1 = Math.max(z1, P[v * 3 + 2]);
    }
    for (let iz = cellOf(z0, oz); iz <= cellOf(z1, oz); iz++)
      for (let iy = cellOf(y0, oy); iy <= cellOf(y1, oy); iy++)
        for (let ix = cellOf(x0, ox); ix <= cellOf(x1, ox); ix++) {
          const k = bucketKey(ix, iy, iz);
          let b = buckets.get(k);
          if (!b) { b = []; buckets.set(k, b); }
          b.push(t);
        }
  }

  // --- 鱗ごとに Dijkstra(上限付き)して、届く三角形を判定する ---
  const dist = new Float64Array(nv).fill(Infinity);
  const stamp = new Int32Array(nv).fill(-1);
  // 各頂点は 1 回しか展開しないので、積む回数は有向辺の数 + 出発点 3 つで収まる
  const heapV = new Int32Array(deg[nv] + 16);
  const heapD = new Float64Array(deg[nv] + 16);
  const triSeen = new Int32Array(nt).fill(-1);
  const target = new Int32Array(nv).fill(-1);   // 判定に要る頂点(候補三角形の角)の印
  const out: number[] = [];

  const every = Math.max(1, Math.floor(sc.count / 50));
  for (let s = 0; s < sc.count; s++) {
    if (s % every === 0) onProgress?.(s / sc.count);
    const sx = sc.pos[s * 3], sy = sc.pos[s * 3 + 1], sz = sc.pos[s * 3 + 2];
    const ts = sc.tri[s];
    const c0 = T[ts * 3], c1 = T[ts * 3 + 1], c2 = T[ts * 3 + 2];

    // 候補の三角形を集める(直線距離 rad 以内)
    const cand: number[] = [];
    const bx = cellOf(sx, ox), by = cellOf(sy, oy), bz = cellOf(sz, oz);
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const b = buckets.get(bucketKey(bx + dx, by + dy, bz + dz));
      if (!b) continue;
      for (const t of b) {
        if (triSeen[t] === s) continue;
        triSeen[t] = s;
        if (t === ts) continue;
        const a = T[t * 3], bb = T[t * 3 + 1], c = T[t * 3 + 2];
        // 鱗の三角形と頂点を共有 → 面でつながっているので常に許す
        if (a === c0 || a === c1 || a === c2 || bb === c0 || bb === c1 || bb === c2 || c === c0 || c === c1 || c === c2) continue;
        cand.push(t);
      }
    }
    if (cand.length === 0) continue;

    // 直線距離 e を先に出し、rad より遠い三角形は捨てる
    const es: number[] = [];
    const cand2: number[] = [];
    for (const t of cand) {
      const e = pointTriDist(P, T[t * 3], T[t * 3 + 1], T[t * 3 + 2], sx, sy, sz);
      if (e > inp.rad) continue;
      cand2.push(t); es.push(e);
    }
    if (cand2.length === 0) continue;
    // lb = dmin - 最長辺 > ratio × e を判定するには、dmin を ratio × rad + 最長辺 まで知っていれば足りる
    let reach = 0;
    for (const t of cand2) reach = Math.max(reach, triMaxEdge[t]);
    reach += inp.ratio * inp.rad;
    // 候補三角形の角がすべて確定したら探索を打ち切る
    let remaining = 0;
    for (const t of cand2) {
      for (let c = 0; c < 3; c++) {
        const v = T[t * 3 + c];
        if (target[v] !== s) { target[v] = s; remaining++; }
      }
    }

    // Dijkstra(鱗の三角形の角から出発)
    let hn = 0;
    const push = (v: number, d: number) => {
      if (stamp[v] === s && d >= dist[v]) return;
      stamp[v] = s; dist[v] = d;
      let k = hn++;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (heapD[p] <= d) break;
        heapV[k] = heapV[p]; heapD[k] = heapD[p]; k = p;
      }
      heapV[k] = v; heapD[k] = d;
    };
    for (const c of [c0, c1, c2]) push(c, Math.hypot(P[c * 3] - sx, P[c * 3 + 1] - sy, P[c * 3 + 2] - sz));
    while (hn > 0) {
      const v = heapV[0], d = heapD[0];
      hn--;
      if (hn > 0) {
        const lv = heapV[hn], ld = heapD[hn];
        let k = 0;
        for (;;) {
          const l = 2 * k + 1;
          if (l >= hn) break;
          const r = l + 1;
          const m = r < hn && heapD[r] < heapD[l] ? r : l;
          if (heapD[m] >= ld) break;
          heapV[k] = heapV[m]; heapD[k] = heapD[m]; k = m;
        }
        heapV[k] = lv; heapD[k] = ld;
      }
      if (d > dist[v] || d > reach) continue;   // 古い項目 / 上限の外
      if (target[v] === s) { target[v] = -1; if (--remaining === 0) break; }
      for (let k = deg[v]; k < deg[v + 1]; k++) {
        const nd = d + len[k];
        if (nd <= reach) push(nbr[k], nd);
      }
    }

    for (let q = 0; q < cand2.length; q++) {
      const t = cand2[q];
      let dmin = Infinity;
      for (let c = 0; c < 3; c++) {
        const v = T[t * 3 + c];
        if (stamp[v] === s) dmin = Math.min(dmin, dist[v]);
      }
      if (dmin === Infinity) dmin = reach;             // 上限まで届かない = reach 以上
      const lb = dmin - triMaxEdge[t];
      if (lb > inp.ratio * es[q]) out.push(t, s);
    }
  }
  return new Uint32Array(out);
}

// 点と三角形の最短距離(Ericson, Real-Time Collision Detection 5.1.5)
export function pointTriDist(P: Float32Array, ia: number, ib: number, ic: number, px: number, py: number, pz: number): number {
  const ax = P[ia * 3], ay = P[ia * 3 + 1], az = P[ia * 3 + 2];
  const abx = P[ib * 3] - ax, aby = P[ib * 3 + 1] - ay, abz = P[ib * 3 + 2] - az;
  const acx = P[ic * 3] - ax, acy = P[ic * 3 + 1] - ay, acz = P[ic * 3 + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const dd = (x: number, y: number, z: number) => Math.hypot(px - x, py - y, pz - z);
  if (d1 <= 0 && d2 <= 0) return dd(ax, ay, az);
  const bpx = px - P[ib * 3], bpy = py - P[ib * 3 + 1], bpz = pz - P[ib * 3 + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return dd(P[ib * 3], P[ib * 3 + 1], P[ib * 3 + 2]);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return dd(ax + abx * v, ay + aby * v, az + abz * v); }
  const cpx = px - P[ic * 3], cpy = py - P[ic * 3 + 1], cpz = pz - P[ic * 3 + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return dd(P[ic * 3], P[ic * 3 + 1], P[ic * 3 + 2]);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return dd(ax + acx * w, ay + acy * w, az + acz * w); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return dd(P[ib * 3] + (P[ic * 3] - P[ib * 3]) * w, P[ib * 3 + 1] + (P[ic * 3 + 1] - P[ib * 3 + 1]) * w, P[ib * 3 + 2] + (P[ic * 3 + 2] - P[ib * 3 + 2]) * w);
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den, w = vc * den;
  return dd(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}
