// 鱗の配置 + 部位の分離判定をまとめた処理。Worker からもメインスレッド(Worker が使えない環境)からも呼ぶ
import { scatterScales, type Progress, type Scales, type ScatterInput } from './scatter';
import { computeSeparation } from './separation';

export interface ScatterJob {
  scatter: ScatterInput;
  separation: { rad: number; ratio: number } | null;   // null なら分離判定をしない
}

export interface ScatterResult {
  scales: Scales;
  forbid: Uint32Array;     // [三角形, 鱗, ...] この三角形にはこの鱗を描かない
  ms: number;              // 配置にかかった時間
  sepMs: number;           // 分離判定にかかった時間
}

export function runScatterJob(job: ScatterJob, onProgress?: Progress): ScatterResult {
  const t0 = performance.now();
  const scales = scatterScales(job.scatter, onProgress);
  const t1 = performance.now();
  // タイルが届く距離はいちばん大きい鱗に合わせる(サイズマップ)
  let smax = 1;
  for (let i = 0; i < scales.count; i++) smax = Math.max(smax, scales.ssz[i]);
  const forbid = job.separation
    ? computeSeparation({
      positions: job.scatter.positions, tris: job.scatter.tris, triMat: job.scatter.triMat,
      matMask: job.scatter.matMask, rad: job.separation.rad * smax, ratio: job.separation.ratio,
    }, scales, (f) => onProgress?.('separate', f))
    : new Uint32Array(0);
  return { scales, forbid, ms: t1 - t0, sepMs: performance.now() - t1 };
}
