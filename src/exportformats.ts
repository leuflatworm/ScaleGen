// 書き出すテクスチャの種類と、ゲームエンジンごとのプリセット。
// 各エンジンの決まり(公式ドキュメントで確認):
//   Unity Built-in / URP … ノーマルは OpenGL 形式(Y+)。Metallic マップは R = メタリック、A = スムースネス
//   Unity HDRP           … Mask Map は R = メタリック、G = AO、B = ディテールマスク、A = スムースネス
//   Unreal Engine        … ノーマルは DirectX 形式(Y−)。ORM は R = AO、G = ラフネス、B = メタリック
//   Godot 4              … ノーマルは OpenGL 形式。ORM は Unreal と同じ並び
//   glTF / Blender       … ノーマルは OpenGL 形式。glTF の metallicRoughness は G = ラフネス、B = メタリック
// 鱗は金属ではないのでメタリックは常に 0。つや(スムースネス = 1 - ラフネス)は画面の値で一様にする。
import { encode } from 'fast-png';
import { png8, png8Exact, pngHeight16 } from './export';

export type MapId = 'baseColor' | 'normal' | 'ao' | 'height' | 'roughness' | 'metalSmooth' | 'maskMap' | 'orm';
export const MAP_IDS: MapId[] = ['baseColor', 'normal', 'ao', 'height', 'roughness', 'metalSmooth', 'maskMap', 'orm'];
// つや(スムースネス / ラフネス)を使うマップ
export const USES_SMOOTHNESS: MapId[] = ['roughness', 'metalSmooth', 'maskMap', 'orm'];

export interface ExportOptions {
  maps: MapId[];
  normal: 'gl' | 'dx';
  heightBits: 8 | 16;
  smoothness: number;      // 0〜1
}

export interface ExportPreset {
  id: string;
  maps: MapId[];
  normal: 'gl' | 'dx';
  heightBits: 8 | 16;
  prefix: string;                          // ファイル名の頭
  names: Partial<Record<MapId, string>>;   // ファイル名の末尾(無い所は DEFAULT_NAMES)
}

export const DEFAULT_NAMES: Record<MapId, string> = {
  baseColor: 'BaseColor', normal: 'Normal', ao: 'AO', height: 'Height',
  roughness: 'Roughness', metalSmooth: 'MetallicSmoothness', maskMap: 'MaskMap', orm: 'ORM',
};

export const EXPORT_PRESETS: ExportPreset[] = [
  // これまでの書き出しと同じ(各エンジンで個別に割り当てる)
  { id: 'standard', maps: ['baseColor', 'normal', 'ao', 'height'], normal: 'gl', heightBits: 16, prefix: '', names: {} },
  { id: 'unity', maps: ['baseColor', 'normal', 'metalSmooth', 'ao', 'height'], normal: 'gl', heightBits: 16, prefix: '', names: { ao: 'Occlusion' } },
  { id: 'hdrp', maps: ['baseColor', 'normal', 'maskMap', 'height'], normal: 'gl', heightBits: 16, prefix: '', names: {} },
  // Unreal のテクスチャ名の慣習(T_ で始め、種類を短い記号で終える)
  { id: 'unreal', maps: ['baseColor', 'normal', 'orm', 'height'], normal: 'dx', heightBits: 16, prefix: 'T_', names: { baseColor: 'BC', normal: 'N', orm: 'ORM', height: 'H' } },
  { id: 'godot', maps: ['baseColor', 'normal', 'orm', 'height'], normal: 'gl', heightBits: 16, prefix: '', names: { baseColor: 'albedo', normal: 'normal', orm: 'orm', height: 'height' } },
  { id: 'blender', maps: ['baseColor', 'normal', 'roughness', 'ao', 'height'], normal: 'gl', heightBits: 16, prefix: '', names: {} },
  // VRChat 向けのトゥーン系シェーダー(lilToon など)はメインカラーとノーマルだけ使うことが多い
  { id: 'vrchat', maps: ['baseColor', 'normal'], normal: 'gl', heightBits: 16, prefix: '', names: {} },
];

// 画面の選択がどのプリセットと同じか(どれとも違えば 'custom')
export function matchPreset(o: Omit<ExportOptions, 'smoothness'>): string {
  const key = (m: MapId[]) => MAP_IDS.filter((id) => m.includes(id)).join(',');
  const k = key(o.maps);
  for (const p of EXPORT_PRESETS) {
    if (key(p.maps) !== k || p.normal !== o.normal) continue;
    if (o.maps.includes('height') && p.heightBits !== o.heightBits) continue;
    return p.id;
  }
  return 'custom';
}

export function fileName(presetId: string, base: string, map: MapId): string {
  const p = EXPORT_PRESETS.find((x) => x.id === presetId);
  return `${p?.prefix ?? ''}${base}_${p?.names[map] ?? DEFAULT_NAMES[map]}.png`;
}

export interface MapSources {
  res: number;
  color: Uint8Array;       // RGBA8(GPU の行順 = 下から)
  normal: Uint8Array;      // RGBA8 OpenGL 形式
  ao: Uint8Array;          // RGBA8(R に AO)
  aux: Float32Array;       // RGBA32F(R に高さ 0〜1)
  colorHasAlpha: boolean;  // BaseColor の透明度(隙間を透過)を正確に残すか
}

// 1 マテリアルぶんのファイルを作る。base = ファイル名の本体(モデル名_マテリアル名)
export async function buildMapFiles(presetId: string, base: string, o: ExportOptions, src: MapSources): Promise<Record<string, Uint8Array>> {
  const { res } = src;
  const n = res * res;
  const files: Record<string, Uint8Array> = {};
  const smooth = Math.round(Math.max(0, Math.min(1, o.smoothness)) * 255);
  const rough = 255 - smooth;
  // 4 チャンネルを組み立てる(行順は GPU のまま。png8 / png8Exact が上下を反転する)
  const pack = (fn: (i: number, out: Uint8Array) => void): Uint8Array => {
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) fn(i, out);
    return out;
  };
  for (const map of o.maps) {
    const name = fileName(presetId, base, map);
    switch (map) {
      case 'baseColor':
        files[name] = src.colorHasAlpha ? png8Exact(src.color, res, res) : await png8(src.color, res, res);
        break;
      case 'normal':
        if (o.normal === 'gl') files[name] = await png8(src.normal, res, res);
        else files[name] = await png8(pack((i, d) => {   // DirectX 形式: 緑(Y)を反転
          d[i * 4] = src.normal[i * 4]; d[i * 4 + 1] = 255 - src.normal[i * 4 + 1]; d[i * 4 + 2] = src.normal[i * 4 + 2]; d[i * 4 + 3] = 255;
        }), res, res);
        break;
      case 'ao':
        files[name] = await png8(src.ao, res, res);
        break;
      case 'height':
        if (o.heightBits === 16) files[name] = pngHeight16(src.aux, res, res);
        else {
          const g = new Uint8Array(n);
          for (let y = 0; y < res; y++) {
            for (let x = 0; x < res; x++) {
              const v = src.aux[((res - 1 - y) * res + x) * 4];
              g[y * res + x] = Math.round(Math.max(0, Math.min(1, v)) * 255);
            }
          }
          files[name] = encode({ width: res, height: res, data: g, channels: 1, depth: 8 });
        }
        break;
      case 'roughness':
        files[name] = encode({ width: res, height: res, data: new Uint8Array(n).fill(rough), channels: 1, depth: 8 });
        break;
      case 'metalSmooth':   // Unity: R = メタリック(0)、A = スムースネス
        files[name] = png8Exact(pack((i, d) => { d[i * 4 + 3] = smooth; }), res, res);
        break;
      case 'maskMap':       // HDRP: R = メタリック(0)、G = AO、B = ディテールマスク(1 = どこでも)、A = スムースネス
        files[name] = png8Exact(pack((i, d) => {
          d[i * 4 + 1] = src.ao[i * 4]; d[i * 4 + 2] = 255; d[i * 4 + 3] = smooth;
        }), res, res);
        break;
      case 'orm':           // R = AO、G = ラフネス、B = メタリック(0)
        files[name] = await png8(pack((i, d) => {
          d[i * 4] = src.ao[i * 4]; d[i * 4 + 1] = rough; d[i * 4 + 3] = 255;
        }), res, res);
        break;
    }
  }
  return files;
}
