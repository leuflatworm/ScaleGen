// マスクで鱗を貼らない範囲を決める。
// 鱗の配置(間引き → 押し広げ → 部位の判定)が確定したあとで、中心がマスクの黒い所に乗っている鱗を取り除く。
// 画素ごとに切り抜くのではなく「鱗ごと」残すか消すかを決めるので、残った鱗は境界をまたいでも形がそのまま残る。
import type { Scales } from './scatter';
import type { SourceImage } from './colorsource';

// マスクの値(0〜1)。明るさ × 不透明度(黒・透明 = 貼らない)。UV は繰り返しとして扱い、バイリニアで引く
export function maskValue(img: SourceImage, u: number, v: number): number {
  const W = img.width, H = img.height;
  const x = (u - Math.floor(u)) * W - 0.5;
  const y = (1 - (v - Math.floor(v))) * H - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  let s = 0;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const px = (((x0 + i) % W) + W) % W, py = (((y0 + j) % H) + H) % H;
      const o = (py * W + px) * 4;
      const d = img.data;
      const lum = (0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]) / 255;
      s += lum * (d[o + 3] / 255) * (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
    }
  }
  return s;
}

export interface MaskResult {
  scales: Scales;
  forbid: Uint32Array;   // 残った鱗の番号に付け直した禁止ペア
  removed: number;
}

// masks: マテリアル番号 → マスク画像。マスクの無いマテリアルの鱗はすべて残す
export function applyMask(sc: Scales, forbid: Uint32Array, masks: Map<number, SourceImage>, invert: boolean): MaskResult {
  if (masks.size === 0) return { scales: sc, forbid, removed: 0 };
  const remap = new Int32Array(sc.count).fill(-1);
  let n = 0;
  for (let i = 0; i < sc.count; i++) {
    const m = masks.get(sc.mat[i]);
    let keep = true;
    if (m) {
      const on = maskValue(m, sc.uv[i * 2], sc.uv[i * 2 + 1]) >= 0.5;
      keep = invert ? !on : on;
    }
    if (keep) remap[i] = n++;
  }
  if (n === sc.count) return { scales: sc, forbid, removed: 0 };

  const pick = <T extends Float32Array | Uint32Array | Uint16Array>(src: T, stride: number, make: (len: number) => T): T => {
    const out = make(n * stride);
    for (let i = 0; i < sc.count; i++) {
      const j = remap[i];
      if (j < 0) continue;
      for (let k = 0; k < stride; k++) out[j * stride + k] = src[i * stride + k];
    }
    return out;
  };
  const f32 = (len: number) => new Float32Array(len);
  const scales: Scales = {
    count: n,
    pos: pick(sc.pos, 3, f32), nrm: pick(sc.nrm, 3, f32), rowdir: pick(sc.rowdir, 3, f32), coldir: pick(sc.coldir, 3, f32),
    sid: pick(sc.sid, 1, f32), uv: pick(sc.uv, 2, f32),
    mat: pick(sc.mat, 1, (len) => new Uint16Array(len)), tri: pick(sc.tri, 1, (len) => new Uint32Array(len)),
    area: sc.area,
  };
  const fb: number[] = [];
  for (let q = 0; q < forbid.length; q += 2) {
    const j = remap[forbid[q + 1]];
    if (j >= 0) fb.push(forbid[q], j);
  }
  return { scales, forbid: new Uint32Array(fb), removed: sc.count - n };
}
