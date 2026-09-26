import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildSurface, surfaceArea, uvArea, type Surface } from './core/surface';
import { computeVertexFlow, type Vec3 } from './core/flow';
import type { Scales } from './core/scatter';
import { runScatterJob, type ScatterJob, type ScatterResult } from './core/job';
import type { Progress } from './core/scatter';
import { TILE_PRESETS, loadTileFile, makePresetTile, tileSize, type TileImage } from './core/tiles';
import { Generator, type TileParams, type MaterialResult, type ShadeOutput, type ShadeParams } from './gpu/pipeline';
import { Viewer } from './viewer';
import { downloadZip, flipRowsRGBA8, png8, pngHeight16 } from './export';
import { placementStats, verify, verifyScaleColors } from './verify';
import { loadSourceImage, scaleColorsFromSources, type SourceImage } from './core/colorsource';
import { checkSupport } from './support';
import { attachNumberFields, sliderValue } from './numfield';
import {
  applyControls, clearSettings, collectControls, dataURLToFile, fileToDataURL, loadSettings, MAX_IMAGE_CHARS, saveSettings,
  type ImageSetting, type TileSetting,
} from './settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
// スライダーの値は数値欄から読む(スライダーの範囲を超えた値も入れられる)
attachNumberFields();
const num = (id: string) => sliderValue(id);

// 動かない環境では、何が足りないかを表示してここで止める
const unsupported = checkSupport();
if (unsupported) {
  const box = document.createElement('div');
  box.className = 'unsupported';
  box.textContent = unsupported;
  $('view').appendChild(box);
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('#panel button, #panel input, #panel select')
    .forEach((e) => { e.disabled = true; });
  throw new Error(unsupported);
}

$('appVersion').textContent = `v${__APP_VERSION__}`;

const viewer = new Viewer($('view'));
const gen = new Generator(viewer.renderer);

const state = {
  modelRoot: null as THREE.Object3D | null,
  modelName: 'model',
  surface: null as Surface | null,
  flow: null as Float32Array | null,
  matMask: [] as boolean[],
  tile: makePresetTile('skink'),
  tileSource: { kind: 'preset', id: 'skink' } as TileSetting,    // 設定の保存用: 鱗の形の出どころ
  tileHSource: null as ImageSetting | null,
  tileTex: null as THREE.Texture | null,
  tileHTex: null as THREE.Texture | null,         // 鱗の高さ画像(任意)
  seed: 1,
  scales: null as Scales | null,
  forbid: new Uint32Array(0) as Uint32Array,   // 離れた部位の禁止ペア [三角形, 鱗, ...]
  results: new Map<number, MaterialResult>(),
  shaded: new Map<number, ShadeOutput>(),
  timings: {} as Record<string, number>,
  sources: new Map<number, SourceImage>(),          // マテリアルごとの元の色テクスチャ
  sourceTex: new Map<number, THREE.Texture>(),
};

// ---------- 1. モデル ----------
// モデルが参照しているテクスチャは使わないので読まない。ローダーに任せると、FBX に書かれたファイル名で
// 公開先のサーバーへリクエストが飛ぶ(利用者のファイル名が外に出る・404 がコンソールに出る)。
// data: / blob: 以外の URL はすべて 1×1 の透明画像に差し替えて、外へは何も取りに行かせない。
const EMPTY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const offlineManager = new THREE.LoadingManager();
offlineManager.setURLModifier((url) => (url.startsWith('data:') || url.startsWith('blob:') ? url : EMPTY_PNG));

async function loadModelBuffer(buf: ArrayBuffer, name: string): Promise<void> {
  const ext = name.split('.').pop()!.toLowerCase();
  let root: THREE.Object3D;
  if (ext === 'fbx') root = new FBXLoader(offlineManager).parse(buf, '');
  else if (ext === 'obj') root = new OBJLoader(offlineManager).parse(new TextDecoder().decode(buf));
  else root = (await new GLTFLoader(offlineManager).parseAsync(buf, '')).scene;
  state.modelRoot = root;
  state.modelName = name.replace(/\.[^.]+$/, '');
  rebuildSurface();
}

function autoUnit(root: THREE.Object3D): number {
  const b = new THREE.Box3().setFromObject(root);
  const h = Math.max(...b.getSize(new THREE.Vector3()).toArray());
  if (h > 200) return 0.001;
  if (h > 20) return 0.01;
  return 1;
}

function rebuildSurface(): void {
  if (!state.modelRoot) return;
  const u = $<HTMLSelectElement>('unit').value;
  const unit = u === 'auto' ? autoUnit(state.modelRoot) : Number(u);
  const s = buildSurface(state.modelRoot, unit);
  state.surface = s;
  state.matMask = s.materials.map(() => true);
  state.sources.clear();
  state.sourceTex.forEach((t) => t.dispose());
  state.sourceTex.clear();
  clearResults();
  viewer.setSurface(s);
  const size = s.bboxMax.map((v, i) => v - s.bboxMin[i]);
  $('modelInfo').textContent =
    `${state.modelName}\n大きさ: 幅 ${fmtLen(size[0])} × 高さ ${fmtLen(size[1])} × 奥行 ${fmtLen(size[2])}\n` +
    `頂点 ${s.positions.length / 3} / 三角形 ${s.triMat.length}`;
  const list = $('matList');
  list.innerHTML = '<div class="hint">鱗を付けるマテリアル</div>';
  s.materials.forEach((m, i) => {
    const l = document.createElement('label');
    l.innerHTML = `<input type="checkbox" checked data-i="${i}"> ${escapeHtml(m)}` +
      (s.uvTiles[i] > 1 ? ` <span class="warn" title="UV が複数の 0〜1 の枠にまたがっています。重なった部分は同じ画素に描かれます">⚠ UV が枠外</span>` : '');
    l.querySelector('input')!.addEventListener('change', (e) => {
      state.matMask[i] = (e.target as HTMLInputElement).checked;
      viewer.setMaterialActive(i, state.matMask[i]);
      updateFlow();
      updateCount();
      renderSourceList();
    });
    list.appendChild(l);
  });
  updateFlow();
  updateCount();
  renderSourceList();
}

$('modelFile').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  setStatus('読み込み中…');
  try {
    await loadModelBuffer(await f.arrayBuffer(), f.name);
    setStatus('');
  } catch (err) {
    setStatus(`読み込みに失敗しました: ${(err as Error).message}`);
  }
});
$('unit').addEventListener('change', rebuildSurface);

// ---------- 2. 鱗の形 ----------
function setTile(t: TileImage, source: TileSetting): void {
  state.tile = t;
  state.tileSource = source;
  state.tileTex?.dispose();
  const tex = new THREE.CanvasTexture(t.canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  state.tileTex = tex;
  setTileHeight(null, '');   // 形を変えたら高さ画像は合わなくなるので外す
  document.querySelectorAll('#tilePresets button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.name === t.name));
  updateCount();
}
for (const p of TILE_PRESETS) {
  const t = makePresetTile(p.id);
  const b = document.createElement('button');
  b.dataset.name = t.name;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  cv.getContext('2d')!.drawImage(t.canvas, 0, 0, 64, 64);
  b.append(cv, p.name);
  b.addEventListener('click', () => { setTile(makePresetTile(p.id), { kind: 'preset', id: p.id }); persist(); });
  $('tilePresets').appendChild(b);
}
$('tileFile').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  setTile(await loadTileFile(f), { kind: 'image', name: f.name, data: await fileToDataURL(f) });
  persist();
});

// 高さ画像: 鱗の形の画像と同じ配置のグレースケール(白 = 高い)。敷き詰めに効くので生成済みなら作り直す
function setTileHeight(canvas: HTMLCanvasElement | null, name: string, source: ImageSetting | null = null): void {
  state.tileHSource = canvas ? source : null;
  state.tileHTex?.dispose();
  state.tileHTex = null;
  if (canvas) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    state.tileHTex = tex;
  }
  $('tileHInfo').textContent = canvas ? `高さ画像: ${name}` : '高さ画像なし(鱗の形から自動で膨らみを作ります)';
  $('tileHClear').hidden = !canvas;
}
async function loadTileHeightFile(f: File): Promise<void> {
  const bmp = await createImageBitmap(f, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const cv = document.createElement('canvas');
  cv.width = bmp.width; cv.height = bmp.height;
  cv.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close();
  setTileHeight(cv, f.name, { name: f.name, data: await fileToDataURL(f) });
}
$('tileHFile').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  await loadTileHeightFile(f);
  persist();
  if (state.results.size > 0) generate();
});
$('tileHClear').addEventListener('click', () => {
  setTileHeight(null, '');
  persist();
  if (state.results.size > 0) generate();
});
setTile(state.tile, state.tileSource);

// ---------- 3. 流れ ----------
function baseDir(): Vec3 {
  return $<HTMLSelectElement>('baseDir').value.split(',').map(Number) as Vec3;
}
function updateFlow(): void {
  if (!state.surface) return;
  const t0 = performance.now();
  state.flow = computeVertexFlow(state.surface, viewer.curves, baseDir());
  state.timings.flowMs = performance.now() - t0;
  viewer.setFlowArrows(state.surface, state.flow, $<HTMLInputElement>('showFlow').checked, state.matMask);
}
viewer.onCurvesChanged = updateFlow;
$('baseDir').addEventListener('change', updateFlow);
$('drawBtn').addEventListener('click', () => {
  viewer.drawMode = !viewer.drawMode;
  $('drawBtn').classList.toggle('on', viewer.drawMode);
});
$('undoCurve').addEventListener('click', () => viewer.undoCurve());
$('clearCurves').addEventListener('click', () => viewer.clearCurves());
$('showFlow').addEventListener('change', (e) => viewer.setFlowVisible((e.target as HTMLInputElement).checked));

// ---------- 4. 大きさ ----------
function spacing(): number { return num('size') * 0.001; }
function updateCount(): void {
  if (!state.surface) { $('countInfo').textContent = ''; return; }
  const a = surfaceArea(state.surface, state.matMask);
  const n = Math.round(a / spacing() ** 2);
  // テクスチャ上で鱗 1 枚が何画素になるか(小さすぎると模様がつぶれる)
  const res = Number($<HTMLSelectElement>('res').value);
  const texel = Math.sqrt(a / Math.max(uvArea(state.surface, state.matMask), 1e-9)) / res;
  const px = spacing() / texel;
  const warn: string[] = [];
  if (n > 400000) warn.push('⚠ 枚数が多すぎます。鱗を大きくしてください');
  if (px < 8) warn.push('⚠ テクスチャ上で鱗が小さすぎます。鱗を大きくするか解像度を上げてください');
  $('countInfo').textContent =
    `鱗の枚数: 約 ${n.toLocaleString()} 枚(面積 ${(a * 1e4).toFixed(0)} cm²)\n` +
    `テクスチャ上の鱗 1 枚: 約 ${px.toFixed(0)} px(${res}px のとき)` +
    (warn.length ? `\n${warn.join('\n')}` : '');
}
['size', 'overlap', 'sizeVar', 'res'].forEach((id) => $(id).addEventListener('input', updateCount));

// ---------- 5. 色 ----------
function hex2rgb(h: string): [number, number, number] {
  const v = parseInt(h.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
function colorMode(): 0 | 1 | 2 {
  return Number($<HTMLSelectElement>('colorMode').value) as 0 | 1 | 2;
}
function shadeParams(): ShadeParams {
  const mc = state.tile.meanColor;
  return {
    colorMode: colorMode(),
    tint: hex2rgb($<HTMLInputElement>('tint').value),
    gap: hex2rgb($<HTMLInputElement>('gap').value),
    tileLum: 0.2126 * mc[0] + 0.7152 * mc[1] + 0.0722 * mc[2],
    briVar: num('briVar'), hueVar: num('hueVar'), fleck: num('fleck'), groove: num('groove'),
    ao: 1, normalStrength: num('normalStrength'),
    belly: $<HTMLInputElement>('belly').checked,
    bellyColor: hex2rgb($<HTMLInputElement>('bellyColor').value),
    bellyDir: $<HTMLSelectElement>('bellyDir').value.split(',').map(Number) as [number, number, number],
    bellyRange: num('bellyRange'),
  };
}
let shadeTimer = 0;
function reshade(): void {
  clearTimeout(shadeTimer);
  shadeTimer = window.setTimeout(() => {
    const t0 = performance.now();
    for (const [mi, r] of state.results) {
      const o = gen.shade(r, shadeParams(), state.sourceTex.get(mi) ?? null);
      state.shaded.set(mi, o);
      viewer.setPreview(mi, o.color, o.normal, r.res);
    }
    state.timings.shadeMs = performance.now() - t0;
    draw2d();
  }, 120);
}
['colorMode', 'tint', 'gap', 'briVar', 'hueVar', 'fleck', 'groove', 'normalStrength', 'belly', 'bellyColor', 'bellyDir', 'bellyRange']
  .forEach((id) => $(id).addEventListener('input', reshade));
$('belly').addEventListener('input', () => { $('bellyOpts').hidden = !$<HTMLInputElement>('belly').checked; });

// --- テクスチャから色を決める ---
function updateColorModeUI(): void {
  const m = colorMode();
  $('srcTexBox').hidden = m !== 2;
  $('gapRow').hidden = m === 2;
  $('tintRow').querySelector('label')!.textContent = m === 2 ? '鱗の色(テクスチャが無い所)' : '鱗の色';
  $('tintRow').hidden = m === 0;
  $('bellyBox').hidden = m === 2;   // テクスチャから色を取るときは元の色に任せる
}
$('colorMode').addEventListener('input', updateColorModeUI);
updateColorModeUI();

function renderSourceList(): void {
  const list = $('srcTexList');
  list.innerHTML = '';
  const s = state.surface;
  if (!s) { list.innerHTML = '<div class="hint">先にモデルを読み込んでください</div>'; return; }
  s.materials.forEach((name, mi) => {
    if (!state.matMask[mi]) return;
    const src = state.sources.get(mi);
    const row = document.createElement('div');
    row.className = 'src';
    const thumb = document.createElement('canvas');
    thumb.width = thumb.height = 40;
    if (src) thumb.getContext('2d')!.drawImage(src.canvas, 0, 0, 40, 40);
    const label = document.createElement('div');
    label.className = 'name';
    label.innerHTML = `${escapeHtml(name)}<small>${src ? escapeHtml(src.name) : '未設定'}</small>`;
    const pick = document.createElement('label');
    pick.className = 'file';
    pick.innerHTML = '画像を選ぶ<input type="file" accept="image/png,image/jpeg,image/webp">';
    pick.querySelector('input')!.addEventListener('change', async (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) await setSource(mi, f);
    });
    row.append(thumb, label, pick);
    list.appendChild(row);
  });
}

async function setSource(mi: number, file: File): Promise<void> {
  const img = await loadSourceImage(file);
  state.sources.set(mi, img);
  state.sourceTex.get(mi)?.dispose();
  const tex = new THREE.CanvasTexture(img.canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  state.sourceTex.set(mi, tex);
  renderSourceList();
  applyScaleColors();
  reshade();
}

// 生成済みの鱗に、中心の位置の色を割り当てる(敷き詰めのやり直しは不要)
function applyScaleColors(): void {
  if (!state.scales) return;
  gen.setScaleColors(scaleColorsFromSources(state.scales, state.sources));
}

// ---------- 6. 生成 ----------
const abortError = () => new DOMException('中止しました', 'AbortError');
const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

// 鱗の配置は Worker で回す。中止は Worker ごと止める。
// Worker が起動できない環境(スクリプトが読めない等)では、画面が一時止まるのを承知でメインスレッドで実行する
// (この場合は途中で中止できない)
function runScatter(inp: ScatterJob, signal: AbortSignal, onProgress: Progress): Promise<ScatterResult> {
  const direct = () => runScatterJob(inp, onProgress);
  return new Promise((ok, ng) => {
    let w: Worker;
    try {
      w = new Worker(new URL('./core/worker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      console.warn('Worker を起動できないためメインスレッドで配置します', err);
      try { ok(direct()); } catch (e2) { ng(e2); }
      return;
    }
    const onAbort = () => { w.terminate(); ng(abortError()); };
    signal.addEventListener('abort', onAbort, { once: true });
    w.onmessage = (e) => {
      if (e.data.type === 'progress') { onProgress(e.data.stage, e.data.f); return; }
      signal.removeEventListener('abort', onAbort);
      w.terminate();
      ok(e.data.result);
    };
    w.onerror = (e) => {
      e.preventDefault();
      signal.removeEventListener('abort', onAbort);
      w.terminate();
      console.warn('Worker でエラーが出たためメインスレッドで配置します', e.message || e);
      try { ok(direct()); } catch (e2) { ng(e2); }
    };
    w.postMessage(inp);
  });
}

// ---- 進み具合の表示(3D ビューの下に出す。パネルをスクロールしていても見える) ----
// 全体を 1 本のバーにする。配置とテクスチャの取り分は、見込み時間の比で決める
// (実測 Akyo: 配置 ≈ 枚数 × 70µs、テクスチャ ≈ 1 秒 × (解像度/2048)² × マテリアル数)。
// 配置の中の割合は 間引き 0.40 / 押し広げ 0.52 / 部位の判定 0.08(24 万枚の実測の比)
const STAGES: Record<string, { from: number; to: number; label: string }> = {
  eliminate: { from: 0, to: 0.4, label: '鱗を配置中' },
  relax: { from: 0.4, to: 0.92, label: '鱗の間隔をそろえています' },
  separate: { from: 0.92, to: 1, label: '離れた部位を判定中' },
};
let progressTimer = 0;
let progressStart = 0;
function showProgress(): void {
  progressStart = performance.now();
  $('progress').hidden = false;
  $('progressTime').textContent = '経過 0.0 秒';
  setProgress(0, '準備中…');
  clearInterval(progressTimer);
  progressTimer = window.setInterval(() => {
    $('progressTime').textContent = `経過 ${((performance.now() - progressStart) / 1000).toFixed(1)} 秒`;
  }, 200);
}
function setProgress(f: number, label: string): void {
  const pct = Math.max(0, Math.min(1, f)) * 100;
  $('progressFill').style.width = `${pct}%`;
  $('progressPct').textContent = `${Math.floor(pct)}%`;
  if (!running?.signal.aborted) $('progressLabel').textContent = label;
}
function hideProgress(): void {
  clearInterval(progressTimer);
  $('progress').hidden = true;
}

function clearResults(): void {
  for (const r of state.results.values()) gen.disposeResult(r);
  state.results.clear();
  state.shaded.clear();
  viewer.clearPreview();
  $<HTMLButtonElement>('exportBtn').disabled = true;
  $<HTMLButtonElement>('view2d').disabled = true;
}

// 鱗がこれより多いときは、始める前に確認する(間違えて重い設定で始めないように)
const CONFIRM_COUNT = 300000;

let busy = false;
let running: AbortController | null = null;
async function generate(): Promise<void> {
  const s = state.surface;
  if (!s || !state.flow || !state.tileTex || busy) return;
  const mats = s.materials.map((_, i) => i).filter((i) => state.matMask[i]);
  if (mats.length === 0) { setStatus('鱗を付けるマテリアルを選んでください'); return; }
  const sp = spacing();
  const estimate = Math.round(surfaceArea(s, state.matMask) / (sp * sp));
  if (estimate > CONFIRM_COUNT &&
    !window.confirm(`鱗が約 ${estimate.toLocaleString()} 枚になり、時間がかかります(途中で中止もできます)。生成しますか?`)) return;

  busy = true;
  const ac = new AbortController();
  running = ac;
  $<HTMLButtonElement>('genBtn').disabled = true;
  $<HTMLButtonElement>('reseed').disabled = true;
  showProgress();
  try {
    clearResults();
    const res = Number($<HTMLSelectElement>('res').value);
    const tAll = performance.now();
    setStatus('生成中…');
    const ts = tileSize(state.tile, sp, num('overlap'));
    const tp: TileParams = {
      tileW: ts.w, tileH: ts.h, sizeVar: num('sizeVar'), flip: $<HTMLInputElement>('flip').checked,
      heightDome: 0.45, maxLayers: 6,
    };
    const separate = $<HTMLInputElement>('separate').checked;
    const estPlace = estimate * 70e-6;
    const estTex = mats.length * (res / 2048) ** 2;
    const placeFrac = Math.min(0.9, Math.max(0.15, estPlace / (estPlace + estTex)));
    const sc = await runScatter({
      scatter: {
        positions: s.positions, normals: s.normals, tris: s.tris, triMat: s.triMat, triUV: s.triUV,
        flow: state.flow, matMask: state.matMask, spacing: sp, seed: state.seed,
      },
      // 面上距離 / 直線距離 > 2.5 なら別の部位(Houdini 版 geo_ratio と同じ値)
      separation: separate ? { rad: Generator.reachRadius(tp), ratio: 2.5 } : null,
    }, ac.signal, (stage, f) => {
      const st = STAGES[stage];
      // 部位の判定をしないときは、押し広げまでで配置の取り分を使い切る
      const to = !separate && stage === 'relax' ? 1 : st.to;
      setProgress(placeFrac * (st.from + (to - st.from) * f), `${st.label}…`);
    });
    if (ac.signal.aborted) throw abortError();
    state.scales = sc.scales;
    state.forbid = sc.forbid;
    state.timings = { scatterMs: sc.ms, separationMs: sc.sepMs };
    gen.setScales(sc.scales, tp, sc.forbid);
    applyScaleColors();
    let k = 0;
    for (const mi of mats) {
      const t0 = performance.now();
      const label = `テクスチャを作成中(${s.materials[mi]}${mats.length > 1 ? ` ${k + 1}/${mats.length}` : ''})…`;
      setProgress(placeFrac + (1 - placeFrac) * (k / mats.length), label);
      const r = await gen.runMaterial(s, mi, res, sp, state.tileTex, state.tileHTex, (f) => {
        setProgress(placeFrac + (1 - placeFrac) * ((k + f * 0.95) / mats.length), label);
      }, ac.signal);
      state.timings[`tile_${s.materials[mi]}`] = performance.now() - t0;
      state.results.set(mi, r);
      // 着色と読み戻し(大きい解像度では 1 秒ほどかかる)。表示を更新してから始める。
      // ⚠ requestAnimationFrame で待たない: 別のタブを見ている間は止まり、生成がそこで止まってしまう
      setProgress(placeFrac + (1 - placeFrac) * ((k + 0.95) / mats.length), `仕上げ中(${s.materials[mi]})…`);
      await new Promise((ok) => setTimeout(ok, 20));
      if (ac.signal.aborted) throw abortError();
      const o = gen.shade(r, shadeParams(), state.sourceTex.get(mi) ?? null);
      state.shaded.set(mi, o);
      viewer.setPreview(mi, o.color, o.normal, res);
      k++;
    }
    setProgress(1, '完了');
    state.timings.totalMs = performance.now() - tAll;
    setStatus(
      `完了: 鱗 ${sc.scales.count.toLocaleString()} 枚 / ${res}px / ${mats.length} マテリアル\n` +
      `配置 ${(sc.ms / 1000).toFixed(2)} 秒` +
      (separate ? `・部位の判定 ${(sc.sepMs / 1000).toFixed(2)} 秒` : '') +
      `・合計 ${(state.timings.totalMs / 1000).toFixed(2)} 秒`,
    );
    $<HTMLButtonElement>('exportBtn').disabled = false;
    $<HTMLButtonElement>('view2d').disabled = false;
    draw2d();
  } catch (err) {
    if (isAbort(err)) {
      clearResults();
      setStatus('中止しました。設定を直して、もう一度「生成」を押してください。');
    } else {
      console.error(err);
      setStatus(`生成に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    busy = false;
    running = null;
    hideProgress();
    $<HTMLButtonElement>('genBtn').disabled = false;
    $<HTMLButtonElement>('reseed').disabled = false;
    $<HTMLButtonElement>('cancelBtn').disabled = false;
  }
}
$('genBtn').addEventListener('click', generate);
$('reseed').addEventListener('click', () => { state.seed++; persist(); generate(); });
$('cancelBtn').addEventListener('click', () => {
  if (!running) return;
  running.abort();
  $<HTMLButtonElement>('cancelBtn').disabled = true;
  $('progressLabel').textContent = '中止しています…';
});

// ---------- 書き出し ----------
async function buildExport(): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  if (!state.surface) return files;
  for (const [mi, r] of state.results) {
    const o = state.shaded.get(mi)!;
    const base = `${safeName(state.modelName)}_${safeName(state.surface.materials[mi])}`;
    files[`${base}_BaseColor.png`] = await png8(o.color, r.res, r.res);
    files[`${base}_Normal.png`] = await png8(o.normal, r.res, r.res);
    files[`${base}_AO.png`] = await png8(o.ao, r.res, r.res);
    files[`${base}_Height.png`] = pngHeight16(gen.readAux(r), r.res, r.res);
  }
  return files;
}
$('exportBtn').addEventListener('click', async () => {
  setStatus('書き出し中…');
  downloadZip(await buildExport(), `${safeName(state.modelName)}_scales.zip`);
  setStatus('書き出しました');
});

// ---------- 2D 表示 ----------
let show2d = false;
$('view2d').addEventListener('click', () => {
  show2d = !show2d;
  $('view2d').classList.toggle('on', show2d);
  $('tex2d').hidden = !show2d;
  draw2d();
});
function draw2d(): void {
  if (!show2d) return;
  const first = state.shaded.entries().next().value;
  if (!first) return;
  const [mi, o] = first;
  const res = state.results.get(mi)!.res;
  const cv = $<HTMLCanvasElement>('tex2d');
  cv.width = cv.height = res;
  cv.getContext('2d')!.putImageData(new ImageData(flipRowsRGBA8(o.color, res, res) as unknown as Uint8ClampedArray<ArrayBuffer>, res, res), 0, 0);
}

// ---------- 小物 ----------
function setStatus(t: string): void { $('status').textContent = t; }
function fmtLen(m: number): string { return m >= 1 ? `${m.toFixed(2)} m` : `${(m * 100).toFixed(1)} cm`; }
function safeName(s: string): string { return s.replace(/[\\/:*?"<>|\s]+/g, '_'); }
function escapeHtml(s: string): string { return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`); }

// ---------- 開発用(検証・自動テスト) ----------
// ---------- 設定の保存と読み込み ----------
// 画面の既定値(HTML に書いた値)。リセットで戻す先
const DEFAULT_CONTROLS = collectControls();
let restoring = false;
let persistTimer = 0;
function persist(): void {
  if (restoring) return;
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    const img = (x: ImageSetting | null) => (x && x.data.length <= MAX_IMAGE_CHARS ? x : null);
    const tile = state.tileSource.kind === 'image' ? img(state.tileSource) && state.tileSource : state.tileSource;
    const tooBig = (state.tileSource.kind === 'image' && !tile) || (state.tileHSource && !img(state.tileHSource));
    $('tileSaveNote').hidden = !tooBig;
    saveSettings({ controls: collectControls(), tile: tile || undefined, tileHeight: img(state.tileHSource), seed: state.seed });
  }, 300);
}
// パネルの入力が変わるたびに保存する(マテリアルの選択など、保存しない項目の変更でも保存し直すだけで害は無い)
$('panel').addEventListener('input', persist);
$('panel').addEventListener('change', persist);

async function restoreSettings(): Promise<void> {
  const saved = loadSettings();
  if (!saved) return;
  restoring = true;
  try {
    applyControls(saved.controls);
    if (typeof saved.seed === 'number' && Number.isFinite(saved.seed)) state.seed = saved.seed;
    const t = saved.tile;
    if (t?.kind === 'preset' && TILE_PRESETS.some((p) => p.id === t.id)) {
      setTile(makePresetTile(t.id), t);
    } else if (t?.kind === 'image') {
      setTile(await loadTileFile(await dataURLToFile(t.data, t.name)), t);
    }
    // 高さ画像は鱗の形のあとに入れる(形を入れると高さ画像は外れるため)
    if (saved.tileHeight) await loadTileHeightFile(await dataURLToFile(saved.tileHeight.data, saved.tileHeight.name));
  } catch (err) {
    console.warn('前回の設定を読み込めませんでした', err);
  } finally {
    restoring = false;
  }
}
const restored = restoreSettings();

$('resetBtn').addEventListener('click', async () => {
  if (!window.confirm('すべての設定を最初の状態に戻しますか?(読み込んだモデルと生成結果はそのままです)')) return;
  await restored;
  restoring = true;
  try {
    applyControls(DEFAULT_CONTROLS);
    setTile(makePresetTile('skink'), { kind: 'preset', id: 'skink' });
    setTileHeight(null, '');
    state.seed = 1;
  } finally {
    restoring = false;
  }
  clearTimeout(persistTimer);
  clearSettings();
  $('tileSaveNote').hidden = true;
  setStatus('設定を最初の状態に戻しました。');
});

if (import.meta.env.DEV) {
  const api = {
    state,
    gen,
    viewer,
    async loadSample(url: string) {
      const buf = await (await fetch(url)).arrayBuffer();
      await loadModelBuffer(buf, url.split('/').pop()!);
    },
    generate,
    buildExport,
    loadBuffer: loadModelBuffer,
    placementStats,
    verify() {
      const s = state.surface!;
      return [...state.results].map(([mi, r]) => verify(s, mi, gen.readAux(r), gen.readPos(r), r.res, state.scales!));
    },
    setCurves(curves: { points: number[] }[]) { viewer.curves = curves; updateFlow(); },
    setSource,
    verifyColors() {
      return [...state.results].filter(([mi]) => state.sources.has(mi)).map(([mi, r]) =>
        verifyScaleColors(state.scales!, state.sources.get(mi)!, mi, state.shaded.get(mi)!.color, gen.readAux(r), gen.readPos(r), r.res));
    },
  };
  (window as unknown as { __sg: typeof api }).__sg = api;
  const sample = new URLSearchParams(location.search).get('sample');
  if (sample) api.loadSample(sample);
}
