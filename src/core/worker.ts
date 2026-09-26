// 散布(と部位の分離判定)は重いので Web Worker で回す
import { runScatterJob, type ScatterJob } from './job';

self.onmessage = (e: MessageEvent<ScatterJob>) => {
  const r = runScatterJob(e.data);
  const sc = r.scales;
  (self as unknown as Worker).postMessage(r, [
    sc.pos.buffer, sc.nrm.buffer, sc.rowdir.buffer, sc.coldir.buffer, sc.sid.buffer, sc.uv.buffer, sc.mat.buffer, sc.tri.buffer,
    r.forbid.buffer,
  ]);
};
