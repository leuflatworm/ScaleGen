// このツールが動く環境かを最初に確かめる。
// UV 空間への焼き込みと敷き詰めで 32bit 浮動小数の描画先を使うので、WebGL2 と EXT_color_buffer_float が要る。
export function checkSupport(): string | null {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) {
    return 'このブラウザでは WebGL2 が使えません。\nパソコン版の Chrome・Edge・Firefox の最新版で開いてください。\n' +
      'それでも表示される場合は、ブラウザの設定で「ハードウェア アクセラレーション」をオンにしてください。';
  }
  if (!gl.getExtension('EXT_color_buffer_float')) {
    return 'このパソコンのグラフィック機能では、テクスチャの計算に必要な機能(浮動小数の描画)が使えません。\n' +
      '別のブラウザ(Chrome・Edge・Firefox の最新版)でお試しください。';
  }
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return null;
}
