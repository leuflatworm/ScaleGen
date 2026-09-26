// PNG 書き出しと zip まとめ。
// GPU から読んだ画素は下の行から並んでいるので、PNG(上の行から)にするとき上下を反転する。
import { encode } from 'fast-png';
import { zipSync } from 'fflate';

export function flipRowsRGBA8(src: Uint8Array, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const row = w * 4;
  for (let y = 0; y < h; y++) out.set(src.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  return out;
}

export async function png8(rgba: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext('2d')!;
  ctx.putImageData(new ImageData(flipRowsRGBA8(rgba, w, h) as unknown as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
  const blob = await cv.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

// 透明を含む RGBA をそのまま PNG にする(canvas を通すと乗算済みアルファの往復で薄い所の色が崩れるため)
export function png8Exact(rgba: Uint8Array, w: number, h: number): Uint8Array {
  return encode({ width: w, height: h, data: flipRowsRGBA8(rgba, w, h), channels: 4, depth: 8 });
}

// 高さは 16bit グレー(aux の R)
export function pngHeight16(aux: Float32Array, w: number, h: number): Uint8Array {
  const d = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = aux[((h - 1 - y) * w + x) * 4];
      d[y * w + x] = Math.round(Math.max(0, Math.min(1, v)) * 65535);
    }
  }
  return encode({ width: w, height: h, data: d, channels: 1, depth: 16 });
}

export function downloadZip(files: Record<string, Uint8Array>, name: string): void {
  const zip = zipSync(files, { level: 0 });
  const url = URL.createObjectURL(new Blob([zip as unknown as BlobPart], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
