// 設定をブラウザ(localStorage)に保存し、次に開いたときに読み込む。
// 保存先はこのパソコンのこのブラウザだけ(どこにも送らない)。使えない環境(プライベートモード等)では何もしない。
// モデルごとに変わるもの(単位・マテリアルの選択・流れのカーブ・元の色テクスチャ)は保存しない。
import { setSliderValue, sliderValue } from './numfield';

const KEY = 'scalegen.settings.v1';

// 保存する入力欄(id)
const SLIDERS = ['size', 'overlap', 'sizeVar', 'sizeBlack', 'bellyRange', 'briVar', 'hueVar', 'fleck', 'groove', 'normalStrength'];
const SELECTS = ['baseDir', 'colorMode', 'res', 'bellyDir'];
const CHECKS = ['flip', 'separate', 'belly', 'showFlow', 'gapClear', 'maskInvert', 'autoSize'];
const COLORS = ['tint', 'gap', 'bellyColor'];

export interface ImageSetting { name: string; data: string }   // data = 元のファイルの data URL
export type TileSetting = { kind: 'preset'; id: string } | ({ kind: 'image' } & ImageSetting);

export interface Settings {
  controls: Record<string, string | number | boolean>;
  tile?: TileSetting;
  tileHeight?: ImageSetting | null;
  seed?: number;
}

// 画像は data URL で持つ。localStorage の容量(多くのブラウザで 5MB 前後)を超えないよう、大きいものは保存しない
export const MAX_IMAGE_CHARS = 1_500_000;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

// いま画面に出ている値を集める
export function collectControls(): Record<string, string | number | boolean> {
  const c: Record<string, string | number | boolean> = {};
  for (const id of SLIDERS) if (el(id)) c[id] = sliderValue(id);
  for (const id of SELECTS) { const e = el<HTMLSelectElement>(id); if (e) c[id] = e.value; }
  for (const id of CHECKS) { const e = el<HTMLInputElement>(id); if (e) c[id] = e.checked; }
  for (const id of COLORS) { const e = el<HTMLInputElement>(id); if (e) c[id] = e.value; }
  return c;
}

// 値を画面に入れ、変更イベントを出す(画面に付いている処理がそのまま動く)
export function applyControls(c: Record<string, string | number | boolean>): void {
  const fire = (e: HTMLElement) => { e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
  for (const id of SLIDERS) if (typeof c[id] === 'number' && Number.isFinite(c[id])) setSliderValue(id, c[id] as number);
  for (const id of SELECTS) {
    const e = el<HTMLSelectElement>(id);
    // 選択肢に無い値(古い保存など)は無視する
    if (e && typeof c[id] === 'string' && [...e.options].some((o) => o.value === c[id])) { e.value = c[id] as string; fire(e); }
  }
  for (const id of CHECKS) {
    const e = el<HTMLInputElement>(id);
    if (e && typeof c[id] === 'boolean') { e.checked = c[id] as boolean; fire(e); }
  }
  for (const id of COLORS) {
    const e = el<HTMLInputElement>(id);
    if (e && typeof c[id] === 'string' && /^#[0-9a-f]{6}$/i.test(c[id] as string)) { e.value = c[id] as string; fire(e); }
  }
}

export function loadSettings(): Settings | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Settings;
    return s && typeof s === 'object' && s.controls ? s : null;
  } catch {
    return null;
  }
}

export function saveSettings(s: Settings): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    return true;
  } catch {
    // 容量オーバーなら画像を外してもう一度
    try {
      const lite: Settings = { ...s, tile: s.tile?.kind === 'image' ? undefined : s.tile, tileHeight: undefined };
      localStorage.setItem(KEY, JSON.stringify(lite));
    } catch { /* 保存できない環境 */ }
    return false;
  }
}

export function clearSettings(): void {
  try { localStorage.removeItem(KEY); } catch { /* 保存できない環境 */ }
}

export function fileToDataURL(f: File): Promise<string> {
  return new Promise((ok, ng) => {
    const r = new FileReader();
    r.onload = () => ok(r.result as string);
    r.onerror = () => ng(r.error);
    r.readAsDataURL(f);
  });
}

export async function dataURLToFile(data: string, name: string): Promise<File> {
  const blob = await (await fetch(data)).blob();
  return new File([blob], name, { type: blob.type });
}
