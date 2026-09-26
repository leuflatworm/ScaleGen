// GPU 側の生成パイプライン。
//   焼き込み → パディング(JFA + 外挿) → 鱗の敷き詰め → ノーマル / AO → 着色
// 敷き詰めまでの結果はマテリアルごとに保持し、色の調整は着色パスだけやり直す。
import * as THREE from 'three';
import type { Surface } from '../core/surface';
import type { Scales } from '../core/scatter';
import { buildHashGrid, nextPow2 } from '../core/hashgrid';
import {
  AO_FS, BAKE_FS, BAKE_VS, FULLSCREEN_VS, JFA_INIT_FS, JFA_STEP_FS, NORMAL_FS, PAD_FS, SHADE_FS, TILER_FS,
} from './shaders';

export interface TileParams {
  tileW: number;        // タイル枠の実寸 [m]
  tileH: number;
  sizeVar: number;      // 鱗の大きさのばらつき
  flip: boolean;
  heightDome: number;
  maxLayers: number;
}

export interface ShadeParams {
  colorMode: 0 | 1 | 2;
  tint: [number, number, number];
  gap: [number, number, number];
  gapClear: boolean;                    // 隙間を透明にする
  tileLum: number;
  briVar: number;
  hueVar: number;
  fleck: number;
  groove: number;
  ao: number;
  normalStrength: number;
  belly: boolean;                       // 腹側の色を変える
  bellyColor: [number, number, number];
  bellyDir: [number, number, number];
  bellyRange: number;
}

export interface MaterialResult {
  res: number;
  pad: THREE.WebGLRenderTarget;    // 0: 位置+島内フラグ / 1: 法線+画素寸法
  tiled: THREE.WebGLRenderTarget;  // 0: 色 / 1: aux / 2: 中心
  spacing: number;
}

export interface ShadeOutput {
  color: Uint8Array;   // RGBA, GL の行順(下から)
  normal: Uint8Array;
  ao: Uint8Array;
}

const SCALE_TEX_W = 2048;

export class Generator {
  private renderer: THREE.WebGLRenderer;
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad = new THREE.PlaneGeometry(2, 2);
  private grid: {
    table: THREE.DataTexture; tableW: number; mask: number;
    s: THREE.DataTexture[]; scaleW: number;
    order: Uint32Array; count: number;
    col: THREE.DataTexture;  // 鱗ごとの色(並べ替え後の順)
    forbid: THREE.DataTexture; forbidW: number; forbidMask: number; forbidCount: number;
    origin: THREE.Vector3; cell: number; rad: number;
    bucketCap: number;   // 1 つのバケットから読む鱗の上限(= 実際の最大個数。以前は 64 固定)
  } | null = null;
  private tp: TileParams | null = null;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
  }

  private pass(fs: string, uniforms: Record<string, THREE.IUniform>): { scene: THREE.Scene; mat: THREE.RawShaderMaterial } {
    const mat = new THREE.RawShaderMaterial({
      vertexShader: FULLSCREEN_VS, fragmentShader: fs, uniforms, glslVersion: THREE.GLSL3,
      depthTest: false, depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.quad, mat);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    return { scene, mat };
  }

  private draw(p: { scene: THREE.Scene; mat: THREE.RawShaderMaterial }, rt: THREE.WebGLRenderTarget, dispose = true): void {
    this.renderer.setRenderTarget(rt);
    this.renderer.render(p.scene, this.camera);
    this.renderer.setRenderTarget(null);
    if (dispose) p.mat.dispose();
  }

  // 鱗の中心をハッシュ格子に入れて GPU へ送る
  // 鱗が届く最大の直線距離(タイル枠の対角の半分 + 大きさのばらつき + 余裕)
  static reachRadius(tp: TileParams): number {
    return 0.5 * Math.hypot(tp.tileW, tp.tileH) * (1 + tp.sizeVar) * 1.05;
  }

  // forbid: [三角形, 鱗(元の番号), ...] この三角形にはこの鱗を描かない
  setScales(sc: Scales, tp: TileParams, forbid: Uint32Array = new Uint32Array(0)): void {
    this.disposeGrid();
    this.tp = tp;
    // サイズマップ: 鱗の枠は倍率 s に比例するので、探索半径はいちばん大きい鱗に合わせる
    let smax = 1;
    for (let i = 0; i < sc.count; i++) smax = Math.max(smax, sc.ssz[i]);
    const rad = Generator.reachRadius(tp) * smax;
    const cell = rad * 1.01;   // 1% 余裕: CPU(double)と GPU(float)のセル割りの差で取りこぼさない
    let ox = Infinity, oy = Infinity, oz = Infinity;
    for (let i = 0; i < sc.count; i++) {
      ox = Math.min(ox, sc.pos[i * 3]); oy = Math.min(oy, sc.pos[i * 3 + 1]); oz = Math.min(oz, sc.pos[i * 3 + 2]);
    }
    const origin: [number, number, number] = [ox - 2 * cell, oy - 2 * cell, oz - 2 * cell];
    const tableSize = nextPow2(sc.count * 2);
    const g = buildHashGrid(sc.pos, sc.count, cell, origin, tableSize);

    const tableW = Math.min(4096, tableSize);
    const tableH = Math.ceil(tableSize / tableW);
    const td = new Float32Array(tableW * tableH * 2);
    let maxBucket = 0;
    for (let h = 0; h < tableSize; h++) {
      td[h * 2] = g.start[h]; td[h * 2 + 1] = g.start[h + 1] - g.start[h];
      maxBucket = Math.max(maxBucket, g.start[h + 1] - g.start[h]);
    }
    const table = dataTex(td, tableW, tableH, THREE.RGFormat);

    const scaleW = Math.min(SCALE_TEX_W, Math.max(1, sc.count));
    const scaleH = Math.ceil(sc.count / scaleW);
    const d = [0, 1, 2, 3].map(() => new Float32Array(scaleW * scaleH * 4));
    const hasForbid = new Uint8Array(sc.count);
    for (let q = 1; q < forbid.length; q += 2) hasForbid[forbid[q]] = 1;
    for (let k = 0; k < sc.count; k++) {
      const i = g.order[k];
      const jr = (1 + tp.sizeVar * (sc.sid[i] - 0.5) * 2) * sc.ssz[i];
      d[0].set([sc.pos[i * 3], sc.pos[i * 3 + 1], sc.pos[i * 3 + 2], sc.sid[i]], k * 4);
      d[1].set([sc.rowdir[i * 3], sc.rowdir[i * 3 + 1], sc.rowdir[i * 3 + 2], jr], k * 4);
      d[2].set([sc.coldir[i * 3], sc.coldir[i * 3 + 1], sc.coldir[i * 3 + 2], hasForbid[i]], k * 4);
      d[3].set([sc.nrm[i * 3], sc.nrm[i * 3 + 1], sc.nrm[i * 3 + 2], sc.ssz[i]], k * 4);
    }
    this.grid = {
      table, tableW, mask: tableSize - 1,
      s: d.map((a) => dataTex(a, scaleW, scaleH, THREE.RGBAFormat)), scaleW,
      origin: new THREE.Vector3(...origin), cell, rad,
      order: g.order, count: sc.count, bucketCap: Math.max(64, maxBucket),
      col: dataTex(new Float32Array(scaleW * scaleH * 4), scaleW, scaleH, THREE.RGBAFormat),
      ...forbidTable(forbid, g.order, sc.count),
    };
  }

  // 1 マテリアル分: 焼き込み → パディング → 敷き詰め
  async runMaterial(
    s: Surface, matIndex: number, res: number, spacing: number, tile: THREE.Texture, tileH: THREE.Texture | null,
    onProgress?: (f: number) => void, signal?: AbortSignal,
  ): Promise<MaterialResult> {
    if (!this.grid || !this.tp) throw new Error('setScales が先');
    const r = this.renderer;
    r.setClearColor(0x000000, 0);

    // 各段階のあとで GPU の完了を待ち、進み具合を報告し、中止を受け付ける。
    // 待つのはフェンス(GPU が終わったかの印)を画面を止めずに見る形なので、待っている間も「中止」を押せる。
    // 描画命令は積むだけで先に進むので、待たないと進み具合が実際より先に進み、中止しても積んだ分が走り続ける。
    // 割合は 4096px の実測に合わせた目安: 焼き込み 5% / パディング(JFA) 55% / 外挿 5% / 敷き詰め 35%
    const owned: THREE.WebGLRenderTarget[] = [];
    const checkpoint = async (f: number) => {
      await waitGPU(r.getContext() as WebGL2RenderingContext);
      onProgress?.(f);
      if (signal?.aborted) throw new DOMException('中止しました', 'AbortError');
    };
    try {
      // --- 焼き込み ---
      // 1 番の w に三角形の番号を入れるので 32bit
      const bake = mrt(res, [THREE.FloatType, THREE.FloatType, THREE.HalfFloatType, THREE.HalfFloatType]);
      owned.push(bake);
      const geo = bakeGeometry(s, matIndex);
      const bmat = new THREE.RawShaderMaterial({
        vertexShader: BAKE_VS, fragmentShader: BAKE_FS, glslVersion: THREE.GLSL3,
        side: THREE.DoubleSide, depthTest: false, depthWrite: false,
      });
      const bmesh = new THREE.Mesh(geo, bmat);
      bmesh.frustumCulled = false;
      const bscene = new THREE.Scene();
      bscene.add(bmesh);
      r.setRenderTarget(bake);
      r.render(bscene, this.camera);
      r.setRenderTarget(null);
      geo.dispose(); bmat.dispose();
      await checkpoint(0.05);

      // --- JFA(種の画素座標だけを持つので 2 チャンネル) ---
      let seedA = rt1(res, THREE.FloatType, THREE.RGFormat), seedB = rt1(res, THREE.FloatType, THREE.RGFormat);
      owned.push(seedA, seedB);
      this.draw(this.pass(JFA_INIT_FS, { tPos: { value: bake.textures[0] } }), seedA);
      const stepPass = this.pass(JFA_STEP_FS, { tSeed: { value: null }, uStep: { value: 1 }, uRes: { value: res } });
      const passes = Math.log2(res);
      let pi = 0;
      try {
        for (let st = res >> 1; st >= 1; st >>= 1) {
          stepPass.mat.uniforms.tSeed.value = seedA.texture;
          stepPass.mat.uniforms.uStep.value = st;
          this.draw(stepPass, seedB, false);
          [seedA, seedB] = [seedB, seedA];
          if (++pi % 2 === 0) await checkpoint(0.05 + 0.55 * (pi / passes));
        }
      } finally {
        stepPass.mat.dispose();
      }

      const pad = mrt(res, [THREE.FloatType, THREE.HalfFloatType, THREE.FloatType]);
      owned.push(pad);
      this.draw(this.pass(PAD_FS, {
        tPos: { value: bake.textures[0] }, tNrm: { value: bake.textures[1] },
        tDu: { value: bake.textures[2] }, tDv: { value: bake.textures[3] },
        tSeed: { value: seedA.texture }, uRes: { value: res }, uPadMax: { value: Math.max(8, res / 32) },
      }), pad);
      await checkpoint(0.65);
      bake.dispose(); seedA.dispose(); seedB.dispose();
      owned.length = 0;
      owned.push(pad);

      // --- 敷き詰め(GPU のタイムアウトを避けるためブロックに分ける) ---
      const g = this.grid, tp = this.tp;
      // 2 番(中心 + 鱗の番号)は番号を正確に持つため 32bit
      const tiled = mrt(res, [THREE.HalfFloatType, THREE.FloatType, THREE.FloatType]);
      owned.push(tiled);
      const tpass = this.pass(TILER_FS, {
        tPos: { value: pad.textures[0] }, tNrm: { value: pad.textures[1] },
        tTable: { value: g.table }, tS0: { value: g.s[0] }, tS1: { value: g.s[1] }, tS2: { value: g.s[2] }, tS3: { value: g.s[3] },
        tTri: { value: pad.textures[2] }, tForbid: { value: g.forbid }, uForbidW: { value: g.forbidW },
        uForbidMask: { value: g.forbidMask }, uUseForbid: { value: g.forbidCount > 0 ? 1 : 0 },
        tTile: { value: tile }, tTileH: { value: tileH }, uHasTileH: { value: tileH ? 1 : 0 },
        uBucketCap: { value: g.bucketCap },
        uTableW: { value: g.tableW }, uScaleW: { value: g.scaleW }, uTableMask: { value: g.mask },
        uOrigin: { value: g.origin }, uCell: { value: g.cell }, uRad: { value: g.rad },
        uTileHalf: { value: new THREE.Vector2(tp.tileW * 0.5, tp.tileH * 0.5) },
        uTileTexW: { value: (tile.image as { width: number }).width },
        uSgn: { value: tp.flip ? -1 : 1 }, uHPow: { value: tp.heightDome }, uVaria: { value: tp.sizeVar },
        uMaxLayers: { value: tp.maxLayers },
      });
      const B = 512;
      const blocks = Math.ceil(res / B) ** 2;
      let done = 0;
      tiled.scissorTest = true;
      try {
        for (let y = 0; y < res; y += B) {
          for (let x = 0; x < res; x += B) {
            tiled.scissor.set(x, y, Math.min(B, res - x), Math.min(B, res - y));
            this.draw(tpass, tiled, false);
            done++;
            if (done % 4 === 0 || done === blocks) await checkpoint(0.65 + 0.35 * (done / blocks));
          }
        }
      } finally {
        tiled.scissorTest = false;
        tpass.mat.dispose();
      }
      return { res, pad, tiled, spacing };
    } catch (e) {
      owned.forEach((t) => t.dispose());
      throw e;
    }
  }

  // 鱗ごとの色を設定する。cols は元の鱗番号順の RGBA(a = 1 なら色あり)
  setScaleColors(cols: Float32Array): void {
    const g = this.grid;
    if (!g) return;
    const d = g.col.image.data as Float32Array;
    d.fill(0);
    for (let k = 0; k < g.count; k++) {
      const i = g.order[k];
      d[k * 4] = cols[i * 4]; d[k * 4 + 1] = cols[i * 4 + 1]; d[k * 4 + 2] = cols[i * 4 + 2]; d[k * 4 + 3] = cols[i * 4 + 3];
    }
    g.col.needsUpdate = true;
  }

  shade(m: MaterialResult, sp: ShadeParams, src: THREE.Texture | null = null): ShadeOutput {
    const res = m.res;
    const aux = m.tiled.textures[1];
    const nrt = rt1(res, THREE.UnsignedByteType);
    this.draw(this.pass(NORMAL_FS, {
      tAux: { value: aux }, uRes: { value: res }, uStrength: { value: sp.normalStrength }, uSpacing: { value: m.spacing },
    }), nrt);
    const art = rt1(res, THREE.UnsignedByteType);
    this.draw(this.pass(AO_FS, { tAux: { value: aux }, uRes: { value: res }, uSpacing: { value: m.spacing } }), art);
    const crt = rt1(res, THREE.UnsignedByteType);
    this.draw(this.pass(SHADE_FS, {
      tCol: { value: m.tiled.textures[0] }, tAux: { value: aux }, tCtr: { value: m.tiled.textures[2] }, tAO: { value: art.texture },
      uColorMode: { value: sp.colorMode }, uTint: { value: new THREE.Vector3(...sp.tint) }, uGap: { value: new THREE.Vector3(...sp.gap) },
      uGapClear: { value: sp.gapClear ? 1 : 0 },
      uTileLum: { value: sp.tileLum }, uBriVar: { value: sp.briVar }, uHueVar: { value: sp.hueVar },
      uFleck: { value: sp.fleck }, uGroove: { value: sp.groove }, uAO: { value: sp.ao },
      uNoiseFreq: { value: 1 / (m.spacing * 12) },
      tScaleCol: { value: this.grid?.col ?? null }, uScaleW: { value: this.grid?.scaleW ?? 1 },
      tSrc: { value: src }, uHasSrc: { value: src ? 1 : 0 }, uRes: { value: res },
      tS3: { value: this.grid?.s[3] ?? null }, uBelly: { value: sp.belly ? 1 : 0 },
      uBellyCol: { value: new THREE.Vector3(...sp.bellyColor) }, uBellyDir: { value: new THREE.Vector3(...sp.bellyDir) },
      uBellyRange: { value: sp.bellyRange },
    }), crt);
    const out: ShadeOutput = {
      color: new Uint8Array(res * res * 4), normal: new Uint8Array(res * res * 4), ao: new Uint8Array(res * res * 4),
    };
    this.renderer.readRenderTargetPixels(crt, 0, 0, res, res, out.color);
    this.renderer.readRenderTargetPixels(nrt, 0, 0, res, res, out.normal);
    this.renderer.readRenderTargetPixels(art, 0, 0, res, res, out.ao);
    nrt.dispose(); art.dispose(); crt.dispose();
    return out;
  }

  // aux(高さ, 乱数, 被覆, 画素寸法)と、島内フラグ付きの位置を読み戻す(書き出しと検証用)
  readAux(m: MaterialResult): Float32Array {
    const b = new Float32Array(m.res * m.res * 4);
    this.renderer.readRenderTargetPixels(m.tiled, 0, 0, m.res, m.res, b, undefined, 1);
    return b;
  }
  readPos(m: MaterialResult): Float32Array {
    const b = new Float32Array(m.res * m.res * 4);
    this.renderer.readRenderTargetPixels(m.pad, 0, 0, m.res, m.res, b, undefined, 0);
    return b;
  }

  disposeResult(m: MaterialResult): void {
    m.pad.dispose();
    m.tiled.dispose();
  }

  private disposeGrid(): void {
    if (!this.grid) return;
    this.grid.table.dispose();
    this.grid.s.forEach((t) => t.dispose());
    this.grid.col.dispose();
    this.grid.forbid.dispose();
    this.grid = null;
  }
}

// 禁止ペアを開番地法のハッシュ表にする。鱗の番号は GPU 側の並び(格子の順)に直す。ハッシュ式は shaders.ts の forbidden() と同じ
function forbidTable(forbid: Uint32Array, order: Uint32Array, count: number) {
  const inv = new Uint32Array(count);
  for (let k = 0; k < count; k++) inv[order[k]] = k;
  const n = forbid.length / 2;
  const size = nextPow2(Math.max(2, n * 2));
  const mask = size - 1;
  const w = Math.min(4096, size), h = Math.ceil(size / w);
  const data = new Float32Array(w * h * 2).fill(-1);
  for (let q = 0; q < n; q++) {
    const tri = forbid[q * 2], si = inv[forbid[q * 2 + 1]];
    let slot = ((Math.imul(tri, 73856093) ^ Math.imul(si, 19349663)) >>> 0) & mask;
    while (data[slot * 2] >= 0) slot = (slot + 1) & mask;
    data[slot * 2] = tri; data[slot * 2 + 1] = si;
  }
  return { forbid: dataTex(data, w, h, THREE.RGFormat), forbidW: w, forbidMask: mask, forbidCount: n };
}

// GPU が積まれた命令を終えるまで、画面を止めずに待つ(WebGL2 のフェンス)
async function waitGPU(gl: WebGL2RenderingContext): Promise<void> {
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) return;
  gl.flush();
  for (;;) {
    const st = gl.clientWaitSync(sync, 0, 0);
    if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED || st === gl.WAIT_FAILED) break;
    await new Promise((ok) => setTimeout(ok, 4));
  }
  gl.deleteSync(sync);
}

function dataTex(data: Float32Array, w: number, h: number, format: THREE.PixelFormat): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, format, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

function rt1(res: number, type: THREE.TextureDataType, format: THREE.PixelFormat = THREE.RGBAFormat): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(res, res, {
    type, format, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, generateMipmaps: false,
  });
}

function mrt(res: number, types: THREE.TextureDataType[]): THREE.WebGLRenderTarget {
  const t = new THREE.WebGLRenderTarget(res, res, {
    count: types.length, type: THREE.FloatType, format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false,
  });
  types.forEach((ty, i) => { t.textures[i].type = ty; });
  return t;
}

// 対象マテリアルの三角形を UV 空間に並べたジオメトリ
function bakeGeometry(s: Surface, matIndex: number): THREE.BufferGeometry {
  const idx: number[] = [];
  for (let t = 0; t < s.triMat.length; t++) if (s.triMat[t] === matIndex) idx.push(t);
  const n = idx.length * 3;
  const uv = new Float32Array(n * 3), P = new Float32Array(n * 3), N = new Float32Array(n * 3);
  const Du = new Float32Array(n * 3), Dv = new Float32Array(n * 3), St = new Float32Array(n), Tri = new Float32Array(n);
  // UV の伸び(ワールド長 / UV 長)を頂点ごとに面積で平均する。三角形ごとの値のままだと辺で段差になる
  const nv = s.positions.length / 3;
  const stSum = new Float64Array(nv), stW = new Float64Array(nv);
  const triStretch = new Float32Array(idx.length);
  idx.forEach((t, k) => {
    const vi = [s.tris[t * 3], s.tris[t * 3 + 1], s.tris[t * 3 + 2]];
    const u = [s.triUV[t * 6], s.triUV[t * 6 + 2], s.triUV[t * 6 + 4]];
    const v = [s.triUV[t * 6 + 1], s.triUV[t * 6 + 3], s.triUV[t * 6 + 5]];
    const p = vi.map((i) => [s.positions[i * 3], s.positions[i * 3 + 1], s.positions[i * 3 + 2]]);
    const e1 = [0, 1, 2].map((a) => p[1][a] - p[0][a]);
    const e2 = [0, 1, 2].map((a) => p[2][a] - p[0][a]);
    const du1 = u[1] - u[0], dv1 = v[1] - v[0], du2 = u[2] - u[0], dv2 = v[2] - v[0];
    const det = du1 * dv2 - du2 * dv1;
    const inv = Math.abs(det) > 1e-12 ? 1 / det : 0;
    const dPdu = [0, 1, 2].map((a) => (e1[a] * dv2 - e2[a] * dv1) * inv);
    const dPdv = [0, 1, 2].map((a) => (e2[a] * du1 - e1[a] * du2) * inv);
    const cx = dPdu[1] * dPdv[2] - dPdu[2] * dPdv[1];
    const cy = dPdu[2] * dPdv[0] - dPdu[0] * dPdv[2];
    const cz = dPdu[0] * dPdv[1] - dPdu[1] * dPdv[0];
    triStretch[k] = Math.sqrt(Math.hypot(cx, cy, cz));
    const area = 0.5 * Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
    for (let c = 0; c < 3; c++) {
      const o = (k * 3 + c) * 3;
      uv[o] = u[c]; uv[o + 1] = v[c]; uv[o + 2] = 0;
      P.set(p[c], o);
      N.set([s.normals[vi[c] * 3], s.normals[vi[c] * 3 + 1], s.normals[vi[c] * 3 + 2]], o);
      Du.set(dPdu, o); Dv.set(dPdv, o);
      Tri[k * 3 + c] = t;
      if (triStretch[k] > 0) { stSum[vi[c]] += triStretch[k] * area; stW[vi[c]] += area; }
    }
  });
  idx.forEach((t, k) => {
    for (let c = 0; c < 3; c++) {
      const vi = s.tris[t * 3 + c];
      St[k * 3 + c] = stW[vi] > 0 ? stSum[vi] / stW[vi] : triStretch[k];
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(uv, 3));
  g.setAttribute('aPos', new THREE.BufferAttribute(P, 3));
  g.setAttribute('aNrm', new THREE.BufferAttribute(N, 3));
  g.setAttribute('aDu', new THREE.BufferAttribute(Du, 3));
  g.setAttribute('aDv', new THREE.BufferAttribute(Dv, 3));
  g.setAttribute('aStretch', new THREE.BufferAttribute(St, 1));
  g.setAttribute('aTri', new THREE.BufferAttribute(Tri, 1));
  return g;
}
