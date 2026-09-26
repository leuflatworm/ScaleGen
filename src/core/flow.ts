// 鱗の「進行方向」(後縁が向く先)を頂点ごとのベクトル場として作る。
// Houdini 版 scale_points/row_direction + smooth_rowdir に相当。
//   - カーブが無ければ「基本の向き」
//   - カーブがあれば、各カーブの最寄り点の接線を距離の逆二乗で混ぜる(描いた向き = 頭→尻尾)。
//     「基本の向き」も距離 influence の位置にある仮想のカーブとして混ぜるので、
//     カーブから遠い所は基本の向きに戻る
//   - 接平面に射影し、面がその方向を向いていて退化する所は別方向で補う
//   - 隣接頂点で 12 回ならす
import { vertexAdjacency, type Surface } from './surface';

export type Vec3 = [number, number, number];
export interface FlowCurve { points: number[] } // xyz を平坦に並べたもの(描いた順)

export function computeVertexFlow(
  s: Surface, curves: FlowCurve[], defaultDir: Vec3, influence = 0.15, iterations = 12,
): Float32Array {
  const nv = s.positions.length / 3;
  const out = new Float32Array(nv * 3);
  const usable = curves.filter((c) => c.points.length >= 6);
  const diag = Math.hypot(s.bboxMax[0] - s.bboxMin[0], s.bboxMax[1] - s.bboxMin[1], s.bboxMax[2] - s.bboxMin[2]);
  const eps2 = (diag * 1e-3) ** 2;

  for (let i = 0; i < nv; i++) {
    const px = s.positions[i * 3], py = s.positions[i * 3 + 1], pz = s.positions[i * 3 + 2];
    let tx = defaultDir[0], ty = defaultDir[1], tz = defaultDir[2];
    if (usable.length > 0) {
      const wb = 1 / ((influence * diag) ** 2 + eps2);
      tx *= wb; ty *= wb; tz *= wb;
      for (const c of usable) {
        const q = c.points;
        let best = Infinity, bx = 0, by = 0, bz = 0;
        for (let k = 0; k + 5 < q.length; k += 3) {
          const ax = q[k], ay = q[k + 1], az = q[k + 2];
          const ex = q[k + 3] - ax, ey = q[k + 4] - ay, ez = q[k + 5] - az;
          const el2 = ex * ex + ey * ey + ez * ez;
          if (el2 <= 0) continue;
          let u = ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / el2;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          const dx = px - (ax + ex * u), dy = py - (ay + ey * u), dz = pz - (az + ez * u);
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < best) { best = d2; const el = Math.sqrt(el2); bx = ex / el; by = ey / el; bz = ez / el; }
        }
        const w = 1 / (best + eps2);
        tx += bx * w; ty += by * w; tz += bz * w;
      }
    }
    const nx = s.normals[i * 3], ny = s.normals[i * 3 + 1], nz = s.normals[i * 3 + 2];
    const [vx, vy, vz] = tangentDir(tx, ty, tz, nx, ny, nz);
    out[i * 3] = vx; out[i * 3 + 1] = vy; out[i * 3 + 2] = vz;
  }

  const adj = vertexAdjacency(nv, s.tris);
  let cur = out, nxt = new Float32Array(out.length);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < nv; i++) {
      const a = adj.start[i], b = adj.start[i + 1];
      let sx = 0, sy = 0, sz = 0;
      for (let k = a; k < b; k++) { const j = adj.list[k]; sx += cur[j * 3]; sy += cur[j * 3 + 1]; sz += cur[j * 3 + 2]; }
      const n = b - a;
      if (n > 0) {
        nxt[i * 3] = 0.5 * cur[i * 3] + 0.5 * sx / n;
        nxt[i * 3 + 1] = 0.5 * cur[i * 3 + 1] + 0.5 * sy / n;
        nxt[i * 3 + 2] = 0.5 * cur[i * 3 + 2] + 0.5 * sz / n;
      } else {
        nxt[i * 3] = cur[i * 3]; nxt[i * 3 + 1] = cur[i * 3 + 1]; nxt[i * 3 + 2] = cur[i * 3 + 2];
      }
    }
    [cur, nxt] = [nxt, cur];
  }
  return cur;
}

// 進行方向を接平面に落とす。退化する所(面が進行方向を向いている)は横方向で補う。
export function tangentDir(tx: number, ty: number, tz: number, nx: number, ny: number, nz: number): Vec3 {
  const d = tx * nx + ty * ny + tz * nz;
  let vx = tx - d * nx, vy = ty - d * ny, vz = tz - d * nz;
  const g = Math.hypot(vx, vy, vz);
  let ax = 0, ay = 0, az = 1;
  let da = az * nz;
  let adx = ax - da * nx, ady = ay - da * ny, adz = az - da * nz;
  if (Math.hypot(adx, ady, adz) < 0.05) {
    ax = 0; ay = 1; az = 0; da = ny;
    adx = ax - da * nx; ady = ay - da * ny; adz = az - da * nz;
  }
  const al = Math.hypot(adx, ady, adz);
  if (al > 1e-5) {
    const k = Math.max(0, 0.3 - g) / al;
    vx += adx * k; vy += ady * k; vz += adz * k;
  }
  return [vx, vy, vz];
}
