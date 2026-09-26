// 3D の点を一様格子に入れ、格子座標をハッシュして CSR で引けるようにする。
// ハッシュ式は GPU 側(gpu/shaders.ts の cellHash)と一致させること。
export function cellHash(ix: number, iy: number, iz: number, mask: number): number {
  return ((Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) >>> 0) & mask;
}

export interface HashGrid {
  origin: [number, number, number];
  cell: number;
  mask: number;          // tableSize - 1
  start: Uint32Array;    // tableSize + 1
  order: Uint32Array;    // バケット順に並べた点番号
}

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export function buildHashGrid(pos: Float32Array, n: number, cell: number, origin: [number, number, number], tableSize: number): HashGrid {
  const mask = tableSize - 1;
  const key = new Uint32Array(n);
  const count = new Uint32Array(tableSize + 1);
  for (let i = 0; i < n; i++) {
    const ix = Math.floor((pos[i * 3] - origin[0]) / cell);
    const iy = Math.floor((pos[i * 3 + 1] - origin[1]) / cell);
    const iz = Math.floor((pos[i * 3 + 2] - origin[2]) / cell);
    const h = cellHash(ix, iy, iz, mask);
    key[i] = h;
    count[h + 1]++;
  }
  const start = new Uint32Array(tableSize + 1);
  for (let h = 0; h < tableSize; h++) start[h + 1] = start[h] + count[h + 1];
  const fill = start.slice(0, tableSize);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[fill[key[i]]++] = i;
  return { origin, cell, mask, start, order };
}

// p の周り 27 セルにいる点を列挙する(同じバケットを 2 度見ない)。
export function forNeighbors(g: HashGrid, x: number, y: number, z: number, fn: (j: number) => void): void {
  const cx = Math.floor((x - g.origin[0]) / g.cell);
  const cy = Math.floor((y - g.origin[1]) / g.cell);
  const cz = Math.floor((z - g.origin[2]) / g.cell);
  const seen: number[] = [];
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const h = cellHash(cx + dx, cy + dy, cz + dz, g.mask);
    if (seen.includes(h)) continue;
    seen.push(h);
    for (let k = g.start[h]; k < g.start[h + 1]; k++) fn(g.order[k]);
  }
}
