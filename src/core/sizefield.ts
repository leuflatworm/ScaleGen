// 場所ごとの鱗の大きさ(サイズマップ)。Houdini 版 leufl::scale_tiler 1.1 の「Scale Size Map」に相当。
//   倍率 s = 最小倍率 + (1 - 最小倍率) × 明るさ(白 = 1 = 「鱗の大きさ」のまま、黒 = 最小倍率。マップ無しは 1)
//   大きくしたいときは「鱗の大きさ」を上げる(最大はそちらで決め、マップは縮める側だけを受け持つ)
//   散布密度は 1/s² 倍、タイル枠は s 倍、起伏は min(s, 1) 倍、鱗の探索半径は max(s) 倍。
// 自動サイズ(細い所で小さくする。autosize.ts)は面に撒いたサンプル点ごとの倍率で渡し、マップの倍率と小さい方を使う。
// Houdini 版はマップを入力メッシュの頂点で読むが、こちらは候補点・鱗の中心の UV で直接読む
// (粗いメッシュでも大きさの境目がぼけない)。
import type { SourceImage } from './colorsource';
import { buildHashGrid, forNeighbors, nextPow2 } from './hashgrid';

// Worker に渡すため、明るさ × 不透明度を 1 チャンネルに詰めたもの(上の行から)
export interface SizeMapData { width: number; height: number; data: Uint8Array }

export interface SizeFieldInput {
  maps: Record<number, SizeMapData>;   // マテリアル番号 → マップ
  min: number;                         // 最小倍率(黒の所。0〜1)
  auto?: AutoSizeField | null;         // 自動サイズ(サンプル点ごとの倍率)
}

// 自動サイズ: 面に撒いたサンプル点と、その点での倍率
export interface AutoSizeField {
  pos: Float32Array;    // N*3
  val: Float32Array;    // N
  radius: number;       // 倍率を読むときに見る半径
  min: number;          // val の最小値
}

// 位置 (x, y, z) での自動サイズの倍率を返す関数を作る。半径内のサンプル点のうち、いちばん小さい値。
// 平均で混ぜると、細い側と太い側のサンプル点の間で値が上限を超える(実測 Akyo 25mm: 882 枚中 14 枚が一周 6 枚を割った)。
// 最小を取れば、その点の周りのどのサンプル点の上限も超えない。押し広げで鱗が動く分(半径の範囲内)もこれで吸収する。
// 近くにサンプル点が無ければ 1
export function autoSizeLookup(f: AutoSizeField): (x: number, y: number, z: number) => number {
  const n = f.val.length, r = f.radius, r2 = r * r;
  let ox = Infinity, oy = Infinity, oz = Infinity;
  for (let i = 0; i < n; i++) { ox = Math.min(ox, f.pos[i * 3]); oy = Math.min(oy, f.pos[i * 3 + 1]); oz = Math.min(oz, f.pos[i * 3 + 2]); }
  const grid = buildHashGrid(f.pos, n, r, [ox - r, oy - r, oz - r], nextPow2(n));
  return (x, y, z) => {
    let m = 1;
    forNeighbors(grid, x, y, z, (j) => {
      const dx = f.pos[j * 3] - x, dy = f.pos[j * 3 + 1] - y, dz = f.pos[j * 3 + 2] - z;
      if (dx * dx + dy * dy + dz * dz < r2 && f.val[j] < m) m = f.val[j];
    });
    return m;
  };
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
  return !!f && (Object.keys(f.maps).length > 0 || !!f.auto);
}

// マテリアル mat の UV (u, v) での倍率
export function sizeAt(f: SizeFieldInput, mat: number, u: number, v: number): number {
  const m = f.maps[mat];
  if (!m) return 1;
  return f.min + (1 - f.min) * sampleSizeMap(m, u, v);
}

// 倍率の取りうる範囲(白 = 1 なので最大は常に 1)
export function sizeRange(f: SizeFieldInput): { min: number; max: number } {
  const mapMin = Object.keys(f.maps).length > 0 ? Math.min(f.min, 1) : 1;
  const autoMin = f.auto ? Math.min(f.auto.min, 1) : 1;
  return { min: Math.min(mapMin, autoMin), max: 1 };
}
