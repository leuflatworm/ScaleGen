// 場所ごとの鱗の大きさ(サイズマップ)。Houdini 版 leufl::scale_tiler 1.1 の「Scale Size Map」に相当。
//   倍率 s = 最小倍率 + (1 - 最小倍率) × 明るさ(白 = 1 = 「鱗の大きさ」のまま、黒 = 最小倍率。マップ無しは 1)
//   大きくしたいときは「鱗の大きさ」を上げる(最大はそちらで決め、マップは縮める側だけを受け持つ)
//   散布密度は 1/s² 倍、タイル枠は s 倍、起伏は min(s, 1) 倍、鱗の探索半径は max(s) 倍。
// Houdini 版はマップを入力メッシュの頂点で読むが、こちらは候補点・鱗の中心の UV で直接読む
// (粗いメッシュでも大きさの境目がぼけない)。
import type { SourceImage } from './colorsource';

// Worker に渡すため、明るさ × 不透明度を 1 チャンネルに詰めたもの(上の行から)
export interface SizeMapData { width: number; height: number; data: Uint8Array }

export interface SizeFieldInput {
  maps: Record<number, SizeMapData>;   // マテリアル番号 → マップ
  min: number;                         // 最小倍率(黒の所。0〜1)
}

export function toSizeMapData(img: SourceImage): SizeMapData {
  const n = img.width * img.height;
  const data = new Uint8Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    const lum = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
    data[i] = Math.round(lum * (d[i * 4 + 3] / 255));
  }
  return { width: img.width, height: img.height, data };
}

// UV(v = 0 が画像の下)でバイリニアに引いた 0〜1。UV は繰り返しとして扱う
export function sampleSizeMap(m: SizeMapData, u: number, v: number): number {
  const W = m.width, H = m.height;
  const x = (u - Math.floor(u)) * W - 0.5;
  const y = (1 - (v - Math.floor(v))) * H - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  let s = 0;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const px = (((x0 + i) % W) + W) % W, py = (((y0 + j) % H) + H) % H;
      s += m.data[py * W + px] * (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
    }
  }
  return s / 255;
}

export function hasSizeField(f: SizeFieldInput | null | undefined): f is SizeFieldInput {
  return !!f && Object.keys(f.maps).length > 0;
}

// マテリアル mat の UV (u, v) での倍率
export function sizeAt(f: SizeFieldInput, mat: number, u: number, v: number): number {
  const m = f.maps[mat];
  if (!m) return 1;
  return f.min + (1 - f.min) * sampleSizeMap(m, u, v);
}

// 倍率の取りうる範囲(白 = 1 なので最大は常に 1)
export function sizeRange(f: SizeFieldInput): { min: number; max: number } {
  return { min: Math.min(f.min, 1), max: 1 };
}
