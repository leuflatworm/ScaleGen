// 鱗 1 枚のタイル画像。
// 規約(Houdini 版と同じ): 画像の下 = 付け根、上 = 後縁(次の鱗に重なる側)。アルファが形を決める。
export interface TileImage {
  name: string;
  canvas: HTMLCanvasElement;
  aspect: number;        // タイル枠の 幅/高さ
  fill: number;          // アルファの平均(枠の何割が鱗か)
  meanColor: [number, number, number]; // アルファで重み付けした平均色 (sRGB 0-1)
}

type Shader = (x: number, y: number) => [number, number, number, number];

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const PRESETS: { id: string; name: string; aspect: number; fn: Shader }[] = [
  {
    // Houdini の tile_test と同じ形: 下がすぼまり上(後縁)が丸い
    id: 'skink', name: '丸瓦', aspect: 5.5 / 5.95,
    fn: (x, y) => {
      const w = 0.92 * (0.55 + 0.45 * smooth(-1, 0.7, y));
      const d = Math.hypot(x / w, y / 0.95);
      const a = 1 - smooth(0.86, 1, d);
      const k = 0.92 + 0.16 * (1 - d * d);
      const e = smooth(0.5, 1, y);
      return [0.2 * k + 0.02 * e, 0.13 * k + 0.035 * e, 0.055 * k + 0.05 * e, a];
    },
  },
  {
    // ヘビのような菱形。中央に稜(キール)
    id: 'snake', name: '菱形', aspect: 0.8,
    fn: (x, y) => {
      const d = Math.abs(x) / 0.92 + Math.abs(y - 0.05) / 0.95;
      const a = 1 - smooth(0.82, 1, d);
      const keel = Math.exp(-((x / 0.13) ** 2)) * smooth(-0.6, 0.6, y);
      const k = 0.85 + 0.2 * (1 - d) + 0.18 * keel;
      return [0.3 * k, 0.28 * k, 0.16 * k, a];
    },
  },
  {
    // 魚のような丸い鱗。後縁に向かって明るく
    id: 'fish', name: '円鱗', aspect: 1.0,
    fn: (x, y) => {
      const d = Math.hypot(x, y) / 0.96;
      const a = 1 - smooth(0.9, 1, d);
      const k = 0.75 + 0.35 * smooth(-0.8, 0.9, y) - 0.1 * d * d;
      return [0.55 * k, 0.6 * k, 0.62 * k, a];
    },
  },
];

export const TILE_PRESETS = PRESETS.map((p) => ({ id: p.id, name: p.name }));

export function makePresetTile(id: string, size = 256): TileImage {
  const p = PRESETS.find((q) => q.id === id) ?? PRESETS[0];
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let r = 0; r < size; r++) {
    const y = 1 - (2 * (r + 0.5)) / size; // 画像の上 = +1(後縁)
    for (let c = 0; c < size; c++) {
      const x = (2 * (c + 0.5)) / size - 1;
      const [cr, cg, cb, a] = p.fn(x, y);
      const o = (r * size + c) * 4;
      img.data[o] = clamp8(cr); img.data[o + 1] = clamp8(cg); img.data[o + 2] = clamp8(cb); img.data[o + 3] = clamp8(a);
    }
  }
  ctx.putImageData(img, 0, 0);
  return analyze(p.name, cv, p.aspect);
}

export async function loadTileFile(file: File): Promise<TileImage> {
  const bmp = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const cv = document.createElement('canvas');
  cv.width = bmp.width; cv.height = bmp.height;
  cv.getContext('2d')!.drawImage(bmp, 0, 0);
  return analyze(file.name, cv, bmp.width / bmp.height);
}

function analyze(name: string, cv: HTMLCanvasElement, aspect: number): TileImage {
  const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
  let sa = 0, sr = 0, sg = 0, sb = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    sa += a; sr += (a * d[i]) / 255; sg += (a * d[i + 1]) / 255; sb += (a * d[i + 2]) / 255;
  }
  const n = d.length / 4;
  const fill = sa / n;
  const meanColor: [number, number, number] = sa > 0 ? [sr / sa, sg / sa, sb / sa] : [0.5, 0.5, 0.5];
  return { name, canvas: cv, aspect, fill: Math.max(fill, 0.05), meanColor };
}

function clamp8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

// 鱗の間隔と重なりから、タイル枠の実寸を決める。
// 被覆 = アルファの埋まり具合 × 枠の面積 / 間隔² (Houdini 版の目安: 2 以上で三叉部に穴が出にくい)
export function tileSize(tile: TileImage, spacing: number, overlap: number): { w: number; h: number } {
  const areaTile = (overlap * spacing * spacing) / tile.fill;
  const w = Math.sqrt(areaTile * tile.aspect);
  return { w, h: areaTile / w };
}
