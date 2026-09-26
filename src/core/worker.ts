// 散布(と部位の分離判定)は重いので Web Worker で回す。
// 進み具合は { type: 'progress' }、結果は { type: 'done' } で返す。中止はメインスレッドが Worker ごと止める
import { runScatterJob, type ScatterJob } from './job';

self.onmessage = (e: MessageEvent<ScatterJob>) => {
  const post = (m: unknown, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);
  let last = 0;
  const r = runScatterJob(e.data, (stage, f) => {
    const now = performance.now();
    if (now - last < 80) return;   // 送りすぎない
    last = now;
    post({ type: 'progress', stage, f });
  });
  const sc = r.scales;
  post({ type: 'done', result: r }, [
    sc.pos.buffer, sc.nrm.buffer, sc.rowdir.buffer, sc.coldir.buffer, sc.sid.buffer, sc.uv.buffer, sc.mat.buffer, sc.tri.buffer,
    r.forbid.buffer,
  ]);
};
