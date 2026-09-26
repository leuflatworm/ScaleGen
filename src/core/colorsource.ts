// 元の色テクスチャ(モデルと同じ UV)から、鱗 1 枚ごとの色を決める。
// 鱗の色 = 鱗の中心の UV 位置の色(バイリニア)。鱗の中の画素ごとには引かない。
import type { Scales } from './scatter';

export interface SourceImage {
  name: string;
  width: number;
  height: number;
  data: Uint8ClampedArray;   // RGBA、上の行から
  canvas: HTMLCanvasElement;
}

export async function loadSourceImage(file: File): Promise<SourceImage> {
  const bmp = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return { name: file.name, width: canvas.width, height: canvas.height, data, canvas };
}

// UV(v = 0 が画像の下)でバイリニアに引く。UV は繰り返しとして扱う
export function sampleUV(img: SourceImage, u: number, v: number): [number, number, number] {
  const W = img.width, H = img.height;
  const x = (u - Math.floor(u)) * W - 0.5;
  const y = (1 - (v - Math.floor(v))) * H - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const out: [number, number, number] = [0, 0, 0];
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const px = (((x0 + i) % W) + W) % W, py = (((y0 + j) % H) + H) % H;
      const w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      const o = (py * W + px) * 4;
      out[0] += (img.data[o] / 255) * w;
      out[1] += (img.data[o + 1] / 255) * w;
      out[2] += (img.data[o + 2] / 255) * w;
    }
  }
  return out;
}

// 鱗ごとの色(元の鱗番号順の RGBA)。中心が乗っているマテリアルに画像が無い鱗は a = 0
export function scaleColorsFromSources(sc: Scales, sources: Map<number, SourceImage>): Float32Array {
  const cols = new Float32Array(sc.count * 4);
  for (let i = 0; i < sc.count; i++) {
    const img = sources.get(sc.mat[i]);
    if (!img) continue;
    const c = sampleUV(img, sc.uv[i * 2], sc.uv[i * 2 + 1]);
    cols[i * 4] = c[0]; cols[i * 4 + 1] = c[1]; cols[i * 4 + 2] = c[2]; cols[i * 4 + 3] = 1;
  }
  return cols;
}
