// 画面の言語(日本語 / English)。
// HTML の固定文言は data-i18n(textContent)/ data-i18n-html(辞書の HTML)/ data-i18n-title(title 属性)で指定し、
// スクリプトで作る文言は t() で引く。言語は設定とは別に保存する(「設定をリセット」で言語は戻さない)。
export type Lang = 'ja' | 'en';

const LANG_KEY = 'scalegen.lang';

const ja = {
  'app.subtitle': '鱗テクスチャジェネレーター(試作)',
  'lang.title': '言語 / Language',
  'reset': '設定をリセット',
  'reset.title': 'すべての設定を最初の状態に戻します',
  'build.date': 'ビルド日 {date}',

  's1': 'モデル',
  'model.open': 'FBX を開く',
  'model.none': 'まだ読み込まれていません',
  'model.info': '{name}\n大きさ: 幅 {w} × 高さ {h} × 奥行 {d}\n頂点 {v} / 三角形 {t}',
  'unit': '単位',
  'unit.auto': '自動',
  'mat.header': '鱗を付けるマテリアル',
  'mat.uvWarn': '⚠ UV が枠外',
  'mat.uvWarnTitle': 'UV が複数の 0〜1 の枠にまたがっています。重なった部分は同じ画素に描かれます',
  'mask.summary': '鱗を貼らない範囲(マスク)',
  'mask.hint': 'モデルと同じ UV の白黒画像を読み込みます。白 = 鱗を貼る、黒・透明 = 貼らない。<br />鱗は「中心が白い所にあるもの」だけが残るので、境界でも 1 枚ずつの形は切れません。',
  'mask.invert': '白黒を反転する(白 = 貼らない)',
  'mask.empty': 'なし(全体に貼る)',

  's2': '鱗の形',
  'tile.skink': '丸瓦',
  'tile.snake': '菱形',
  'tile.fish': '円鱗',
  'tile.load': '画像を読み込む(PNG・透過)',
  'tile.height': '高さ画像(任意)',
  'tile.saveNote': '画像が大きいため、次に開いたときには読み込まれません(ほかの設定は保存されます)',
  'tile.noHeight': '高さ画像なし(鱗の形から自動で膨らみを作ります)',
  'tile.heightName': '高さ画像: {name}',
  'tile.orient': '画像の下 = 付け根、上 = 先端(次の鱗に重なる側)',

  's3': '流れ',
  'flow.base': '基本の向き',
  'dir.down': '下へ',
  'dir.up': '上へ',
  'dir.back': '後ろへ',
  'dir.front': '前へ',
  'dir.right': '右へ',
  'dir.left': '左へ',
  'flow.draw': '✎ 流れを描く',
  'flow.undo': '1本戻す',
  'flow.clear': '全部消す',
  'flow.hint': '「流れを描く」をオンにして、モデルの上を <b>頭 → 尻尾</b> の向きにドラッグ。描いた線の近くほど強く効きます。',
  'flow.show': '流れの矢印を表示',

  's4': '大きさ',
  'size.size': '鱗の大きさ',
  'count.info': '鱗の枚数: 約 {n} 枚(面積 {a} cm²)\nテクスチャ上の鱗 1 枚: 約 {px} px({res}px のとき)',
  'count.tooMany': '⚠ 枚数が多すぎます。鱗を大きくしてください',
  'count.tooSmall': '⚠ テクスチャ上で鱗が小さすぎます。鱗を大きくするか解像度を上げてください',
  'sizemap.summary': '場所ごとに大きさを変える(サイズマップ)',
  'sizemap.hint': 'モデルと同じ UV の白黒画像を読み込むと、明るさに応じて鱗が小さくなります。白 = 「鱗の大きさ」のまま、黒 = 「最小倍率」まで小さく。小さくした所ほど鱗が多く並びます。',
  'sizemap.min': '最小倍率',
  'sizemap.empty': 'なし(どこも同じ大きさ)',
  'adv': '詳しい設定',
  'adv.overlap': '重なり',
  'adv.sizeVar': '大きさのばらつき',
  'adv.flip': '鱗の向きを反転',
  'adv.separate': '離れた部位の鱗を混ぜない(指の間など)',

  's5': '色',
  'color.mode': '色の付け方',
  'color.pick': '色を指定',
  'color.tex': 'テクスチャから',
  'color.tile': '鱗の画像の色のまま',
  'color.texHint': 'モデルの色テクスチャ(同じ UV のもの)を読み込むと、鱗の中心の位置の色がその鱗 1 枚の色になります。隙間はその場所の色を暗くしたものになります。',
  'color.tint': '鱗の色',
  'color.tintNoTex': '鱗の色(テクスチャが無い所)',
  'color.gap': '隙間の色',
  'color.gapClear': '隙間(透明)',
  'color.gapDark': '隙間(元の色を暗く)',
  'color.clear': '透過',
  'color.clearTitle': '鱗の無い所を透明にします(BaseColor の透明度 = 鱗の被覆)',
  'belly': 'お腹側の色を変える',
  'belly.color': 'お腹の色',
  'belly.dir': 'お腹の向き',
  'bdir.front': '前',
  'bdir.down': '下',
  'bdir.back': '後ろ',
  'belly.range': 'お腹の色の範囲',
  'color.briVar': '鱗ごとの明るさの差',
  'color.hueVar': '鱗ごとの色味の差',
  'color.fleck': 'まだら模様',
  'color.groove': '溝の暗さ',
  'color.normal': '凹凸の強さ',

  's6': '生成と書き出し',
  'res': '解像度',
  'gen': '生成',
  'reseed': '別のパターン',
  'export': 'ZIP で書き出し',
  'view2d': '2D で見る',
  'cancel': '中止',
  'about.privacy': '読み込んだモデルと画像は、このパソコンの中(ブラウザ)だけで処理されます。どこにも送信・保存されません。',
  'about.browsers': '推奨: パソコン版の Chrome・Edge・Firefox の最新版',
  'about.link': '使い方・ソースコード(GitHub)',

  'needModel': '先にモデルを読み込んでください',
  'src.unset': '未設定',
  'pickImage': '画像を選ぶ',
  'remove': '外す',

  'stage.eliminate': '鱗を配置中',
  'stage.relax': '鱗の間隔をそろえています',
  'stage.separate': '離れた部位を判定中',
  'prog.elapsed': '経過 {s} 秒',
  'prog.preparing': '準備中…',
  'prog.texture': 'テクスチャを作成中({mat}{part})…',
  'prog.finish': '仕上げ中({mat})…',
  'prog.done': '完了',
  'prog.cancelling': '中止しています…',

  'status.loading': '読み込み中…',
  'status.loadFail': '読み込みに失敗しました: {msg}',
  'status.pickMat': '鱗を付けるマテリアルを選んでください',
  'status.generating': '生成中…',
  'status.done': '完了: 鱗 {n} 枚{masked} / {res}px / {m} マテリアル\n配置 {place} 秒{sep}・合計 {total} 秒',
  'status.masked': '(マスクで {n} 枚を除去)',
  'status.sep': '・部位の判定 {s} 秒',
  'status.aborted': '中止しました。設定を直して、もう一度「生成」を押してください。',
  'status.genFail': '生成に失敗しました: {msg}',
  'status.exporting': '書き出し中…',
  'status.exported': '書き出しました',
  'status.reset': '設定を最初の状態に戻しました。',
  'confirm.many': '鱗が約 {n} 枚になり、時間がかかります(途中で中止もできます)。生成しますか?',
  'confirm.reset': 'すべての設定を最初の状態に戻しますか?(読み込んだモデルと生成結果はそのままです)',
  'err.maskAll': 'マスクで鱗がすべて取り除かれました。マスクの白黒(反転)を確かめてください',
  'err.aborted': '中止しました',

  'unsupported.webgl2': 'このブラウザでは WebGL2 が使えません。\nパソコン版の Chrome・Edge・Firefox の最新版で開いてください。\nそれでも表示される場合は、ブラウザの設定で「ハードウェア アクセラレーション」をオンにしてください。',
  'unsupported.float': 'このパソコンのグラフィック機能では、テクスチャの計算に必要な機能(浮動小数の描画)が使えません。\n別のブラウザ(Chrome・Edge・Firefox の最新版)でお試しください。',
};

type Key = keyof typeof ja;

const en: Record<Key, string> = {
  'app.subtitle': 'Scale texture generator (prototype)',
  'lang.title': 'Language / 言語',
  'reset': 'Reset settings',
  'reset.title': 'Reset all settings to their defaults',
  'build.date': 'Built {date}',

  's1': 'Model',
  'model.open': 'Open FBX',
  'model.none': 'No model loaded yet',
  'model.info': '{name}\nSize: W {w} × H {h} × D {d}\nVertices {v} / Triangles {t}',
  'unit': 'Units',
  'unit.auto': 'Auto',
  'mat.header': 'Materials to cover with scales',
  'mat.uvWarn': '⚠ UV outside 0–1',
  'mat.uvWarnTitle': 'The UVs span more than one 0–1 tile. Overlapping parts are drawn to the same pixels',
  'mask.summary': 'Areas without scales (mask)',
  'mask.hint': 'Load a black-and-white image that uses the model\'s UVs. White = scales, black or transparent = no scales.<br />Only scales whose center lies on white are kept, so scales along the border stay whole instead of being cut.',
  'mask.invert': 'Invert (white = no scales)',
  'mask.empty': 'None (scales everywhere)',

  's2': 'Scale shape',
  'tile.skink': 'Round tile',
  'tile.snake': 'Diamond',
  'tile.fish': 'Cycloid',
  'tile.load': 'Load image (PNG with transparency)',
  'tile.height': 'Height image (optional)',
  'tile.saveNote': 'This image is too large to be restored next time (other settings are saved)',
  'tile.noHeight': 'No height image (a dome is generated from the scale shape)',
  'tile.heightName': 'Height image: {name}',
  'tile.orient': 'Image bottom = base, top = tip (the side that overlaps the next scale)',

  's3': 'Flow',
  'flow.base': 'Base direction',
  'dir.down': 'Down',
  'dir.up': 'Up',
  'dir.back': 'Backward',
  'dir.front': 'Forward',
  'dir.right': 'Right',
  'dir.left': 'Left',
  'flow.draw': '✎ Draw flow',
  'flow.undo': 'Undo line',
  'flow.clear': 'Clear all',
  'flow.hint': 'Turn on "Draw flow" and drag across the model from <b>head → tail</b>. Each line has the most influence near where it is drawn.',
  'flow.show': 'Show flow arrows',

  's4': 'Size',
  'size.size': 'Scale size',
  'count.info': 'Scales: about {n} (area {a} cm²)\nOne scale on the texture: about {px} px (at {res}px)',
  'count.tooMany': '⚠ Too many scales. Increase the scale size',
  'count.tooSmall': '⚠ Scales are too small on the texture. Increase the scale size or the resolution',
  'sizemap.summary': 'Vary size by location (size map)',
  'sizemap.hint': 'Load a black-and-white image that uses the model\'s UVs to make scales smaller by brightness. White = "Scale size" as is, black = shrunk to the "Minimum ratio". Smaller areas get more scales.',
  'sizemap.min': 'Minimum ratio',
  'sizemap.empty': 'None (same size everywhere)',
  'adv': 'Advanced',
  'adv.overlap': 'Overlap',
  'adv.sizeVar': 'Size variation',
  'adv.flip': 'Flip scale direction',
  'adv.separate': 'Keep separate body parts apart (e.g. between fingers)',

  's5': 'Color',
  'color.mode': 'Coloring',
  'color.pick': 'Pick a color',
  'color.tex': 'From texture',
  'color.tile': 'Scale image colors',
  'color.texHint': 'Load the model\'s color texture (same UVs). Each scale takes the color at its center. Gaps use a darkened version of the color at that spot.',
  'color.tint': 'Scale color',
  'color.tintNoTex': 'Scale color (where there is no texture)',
  'color.gap': 'Gap color',
  'color.gapClear': 'Gap (transparent)',
  'color.gapDark': 'Gap (darkened original color)',
  'color.clear': 'Transparent',
  'color.clearTitle': 'Make areas without scales transparent (BaseColor alpha = scale coverage)',
  'belly': 'Different belly color',
  'belly.color': 'Belly color',
  'belly.dir': 'Belly faces',
  'bdir.front': 'Front',
  'bdir.down': 'Down',
  'bdir.back': 'Back',
  'belly.range': 'Belly color extent',
  'color.briVar': 'Per-scale brightness variation',
  'color.hueVar': 'Per-scale hue variation',
  'color.fleck': 'Mottling',
  'color.groove': 'Groove darkness',
  'color.normal': 'Bump strength',

  's6': 'Generate & export',
  'res': 'Resolution',
  'gen': 'Generate',
  'reseed': 'New pattern',
  'export': 'Export ZIP',
  'view2d': 'View in 2D',
  'cancel': 'Cancel',
  'about.privacy': 'Models and images you load are processed only on this computer (in your browser). Nothing is uploaded or stored anywhere.',
  'about.browsers': 'Recommended: the latest desktop Chrome, Edge, or Firefox',
  'about.link': 'Guide & source code (GitHub)',

  'needModel': 'Load a model first',
  'src.unset': 'Not set',
  'pickImage': 'Choose image',
  'remove': 'Remove',

  'stage.eliminate': 'Placing scales',
  'stage.relax': 'Evening out scale spacing',
  'stage.separate': 'Detecting separate body parts',
  'prog.elapsed': 'Elapsed {s} s',
  'prog.preparing': 'Preparing…',
  'prog.texture': 'Building texture ({mat}{part})…',
  'prog.finish': 'Finishing ({mat})…',
  'prog.done': 'Done',
  'prog.cancelling': 'Cancelling…',

  'status.loading': 'Loading…',
  'status.loadFail': 'Failed to load: {msg}',
  'status.pickMat': 'Select at least one material to cover with scales',
  'status.generating': 'Generating…',
  'status.done': 'Done: {n} scales{masked} / {res}px / {m} material(s)\nPlacement {place} s{sep} · total {total} s',
  'status.masked': ' ({n} removed by the mask)',
  'status.sep': ' · part detection {s} s',
  'status.aborted': 'Cancelled. Adjust the settings and press "Generate" again.',
  'status.genFail': 'Generation failed: {msg}',
  'status.exporting': 'Exporting…',
  'status.exported': 'Exported',
  'status.reset': 'Settings have been reset.',
  'confirm.many': 'This will create about {n} scales and may take a while (you can cancel partway). Generate?',
  'confirm.reset': 'Reset all settings to their defaults? (The loaded model and generated results are kept.)',
  'err.maskAll': 'The mask removed every scale. Check the mask\'s black and white (the invert option)',
  'err.aborted': 'Cancelled',

  'unsupported.webgl2': 'WebGL2 is not available in this browser.\nPlease open this page in the latest desktop Chrome, Edge, or Firefox.\nIf you still see this message, turn on "hardware acceleration" in your browser settings.',
  'unsupported.float': 'This computer\'s graphics do not support a feature needed for the texture calculations (floating-point rendering).\nPlease try another browser (the latest Chrome, Edge, or Firefox).',
};

const DICT: Record<Lang, Record<Key, string>> = { ja, en };

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'ja' || saved === 'en') return saved;
  } catch { /* 保存が使えない環境 */ }
  const prefs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return prefs.some((l) => l?.toLowerCase().startsWith('ja')) ? 'ja' : 'en';
}

let lang: Lang = initialLang();
const listeners: (() => void)[] = [];

export function getLang(): Lang { return lang; }

export function t(key: Key, vars?: Record<string, string | number>): string {
  const s = DICT[lang][key] ?? ja[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

// HTML の data-i18n 系の属性が付いた要素に、いまの言語の文言を入れる
export function applyStatic(root: ParentNode = document): void {
  document.documentElement.lang = lang;
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((e) => { e.textContent = t(e.dataset.i18n as Key); });
  root.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach((e) => { e.innerHTML = t(e.dataset.i18nHtml as Key); });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((e) => { e.title = t(e.dataset.i18nTitle as Key); });
}

export function setLang(l: Lang): void {
  if (l === lang) return;
  lang = l;
  try { localStorage.setItem(LANG_KEY, l); } catch { /* 保存が使えない環境 */ }
  applyStatic();
  listeners.forEach((f) => f());
}

// 言語が変わったときに、スクリプトで作った文言を作り直す処理を登録する
export function onLangChange(f: () => void): void { listeners.push(f); }
