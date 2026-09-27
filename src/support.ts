// このツールが動く環境かを最初に確かめる。
// UV 空間への焼き込みと敷き詰めで 32bit 浮動小数の描画先を使うので、WebGL2 と EXT_color_buffer_float が要る。
import { t } from './i18n';

export function checkSupport(): string | null {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) {
    return t('unsupported.webgl2');
  }
  if (!gl.getExtension('EXT_color_buffer_float')) {
    return t('unsupported.float');
  }
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return null;
}
