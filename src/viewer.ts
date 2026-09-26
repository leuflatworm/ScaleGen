// 3D ビュー: モデル表示・流れのカーブ描画・流れの矢印・生成結果のプレビュー
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import type { Surface } from './core/surface';
import type { FlowCurve } from './core/flow';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.001, 100);
  private controls: OrbitControls;
  private mesh: THREE.Mesh | null = null;
  private mats: THREE.MeshStandardMaterial[] = [];
  private curveGroup = new THREE.Group();
  private flowLines: THREE.LineSegments | null = null;
  private raycaster = new THREE.Raycaster();
  private diag = 1;
  curves: FlowCurve[] = [];
  drawMode = false;
  onCurvesChanged: () => void = () => {};

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x2a2d33);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(1.5, 2.5, 2);
    this.camera.add(sun);
    this.scene.add(this.camera);
    this.scene.add(this.curveGroup);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    (this.raycaster as unknown as { firstHitOnly: boolean }).firstHitOnly = true;

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.installDrawing();
    const loop = () => {
      this.controls.update();
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
  }

  private resize(): void {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setSurface(s: Surface): void {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.disposeBoundsTree();
      this.mesh.geometry.dispose();
      this.mats.forEach((m) => m.dispose());
    }
    const nt = s.triMat.length;
    const pos = new Float32Array(nt * 9), nrm = new Float32Array(nt * 9), uv = new Float32Array(nt * 6);
    const g = new THREE.BufferGeometry();
    let k = 0;
    for (let mi = 0; mi < s.materials.length; mi++) {
      const start = k;
      for (let t = 0; t < nt; t++) {
        if (s.triMat[t] !== mi) continue;
        for (let c = 0; c < 3; c++) {
          const v = s.tris[t * 3 + c];
          pos.set(s.positions.subarray(v * 3, v * 3 + 3), (k * 3 + c) * 3);
          nrm.set(s.normals.subarray(v * 3, v * 3 + 3), (k * 3 + c) * 3);
          uv[(k * 3 + c) * 2] = s.triUV[t * 6 + c * 2];
          uv[(k * 3 + c) * 2 + 1] = s.triUV[t * 6 + c * 2 + 1];
        }
        k++;
      }
      g.addGroup(start * 3, (k - start) * 3, mi);
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.computeBoundsTree();
    this.mats = s.materials.map(() => new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.75, side: THREE.DoubleSide }));
    this.mesh = new THREE.Mesh(g, this.mats);
    this.scene.add(this.mesh);

    const min = new THREE.Vector3(...s.bboxMin), max = new THREE.Vector3(...s.bboxMax);
    const center = min.clone().add(max).multiplyScalar(0.5);
    this.diag = min.distanceTo(max);
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(0, 0, this.diag * 1.6));
    this.camera.near = this.diag * 0.001;
    this.camera.far = this.diag * 20;
    this.camera.updateProjectionMatrix();
    this.clearCurves();
  }

  setFlowArrows(s: Surface, flow: Float32Array, visible: boolean, matMask: boolean[]): void {
    if (this.flowLines) {
      this.scene.remove(this.flowLines);
      this.flowLines.geometry.dispose();
      (this.flowLines.material as THREE.Material).dispose();
      this.flowLines = null;
    }
    const nv = s.positions.length / 3;
    const active = new Uint8Array(nv);
    for (let t = 0; t < s.triMat.length; t++) {
      if (matMask[s.triMat[t]]) { active[s.tris[t * 3]] = 1; active[s.tris[t * 3 + 1]] = 1; active[s.tris[t * 3 + 2]] = 1; }
    }
    const step = Math.max(1, Math.ceil(nv / 4000));
    const len = this.diag * 0.02, lift = this.diag * 0.002;
    const p: number[] = [], c: number[] = [];
    for (let i = 0; i < nv; i += step) {
      const fx = flow[i * 3], fy = flow[i * 3 + 1], fz = flow[i * 3 + 2];
      const fl = Math.hypot(fx, fy, fz);
      if (fl < 1e-6 || !active[i]) continue;
      const nx = s.normals[i * 3] * lift, ny = s.normals[i * 3 + 1] * lift, nz = s.normals[i * 3 + 2] * lift;
      const x = s.positions[i * 3] + nx, y = s.positions[i * 3 + 1] + ny, z = s.positions[i * 3 + 2] + nz;
      p.push(x, y, z, x + (fx / fl) * len, y + (fy / fl) * len, z + (fz / fl) * len);
      c.push(0.1, 0.25, 0.6, 0.55, 0.95, 1.0);   // 根元(暗い青) → 後縁(明るい水色)
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    this.flowLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }));
    this.flowLines.visible = visible;
    this.scene.add(this.flowLines);
  }

  // 鱗を付けないマテリアルは半透明にして、邪魔にならないようにする
  setMaterialActive(i: number, active: boolean): void {
    const m = this.mats[i];
    if (!m) return;
    m.transparent = !active;
    m.opacity = active ? 1 : 0.15;
    m.depthWrite = active;
    m.needsUpdate = true;
  }

  setFlowVisible(v: boolean): void {
    if (this.flowLines) this.flowLines.visible = v;
  }

  setPreview(matIndex: number, color: Uint8Array, normal: Uint8Array, res: number, clear = false): void {
    const m = this.mats[matIndex];
    if (!m) return;
    m.map?.dispose();
    m.normalMap?.dispose();
    const mk = (d: Uint8Array, cs: THREE.ColorSpace) => {
      const t = new THREE.DataTexture(d, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.colorSpace = cs;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      t.needsUpdate = true;
      return t;
    };
    m.map = mk(color, THREE.SRGBColorSpace);
    m.normalMap = mk(normal, THREE.NoColorSpace);
    m.color.set(0xffffff);
    m.roughness = 0.55;
    // 隙間を透明にしたときは、被覆が半分未満の所を抜いて表示する
    m.alphaTest = clear ? 0.5 : 0;
    m.needsUpdate = true;
  }

  clearPreview(): void {
    for (const m of this.mats) {
      m.map?.dispose(); m.normalMap?.dispose();
      m.map = null; m.normalMap = null;
      m.alphaTest = 0;
      m.color.set(0x9a9a9a);
      m.needsUpdate = true;
    }
  }

  // ---- 流れのカーブ ----
  clearCurves(): void {
    this.curves = [];
    this.curveGroup.clear();
    this.onCurvesChanged();
  }

  undoCurve(): void {
    this.curves.pop();
    const last = this.curveGroup.children[this.curveGroup.children.length - 1];
    if (last) this.curveGroup.remove(last);
    this.onCurvesChanged();
  }

  // 画面座標でモデルに当たる点を返す
  private pick(ev: PointerEvent): { p: THREE.Vector3; n: THREE.Vector3 } | null {
    if (!this.mesh) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit || !hit.face) return null;
    return { p: hit.point.clone(), n: hit.face.normal.clone() };
  }

  private installDrawing(): void {
    let stroke: { pts: number[]; disp: THREE.Vector3[]; line: THREE.Line; group: THREE.Group } | null = null;
    const lineMat = new THREE.LineBasicMaterial({ color: 0xffa31a });
    const add = (h: { p: THREE.Vector3; n: THREE.Vector3 }) => {
      if (!stroke) return;
      stroke.pts.push(h.p.x, h.p.y, h.p.z);
      stroke.disp.push(h.p.clone().addScaledVector(h.n, this.diag * 0.003));
      stroke.line.geometry.dispose();
      stroke.line.geometry = new THREE.BufferGeometry().setFromPoints(stroke.disp);
    };
    this.container.addEventListener('pointerdown', (ev) => {
      if (!this.drawMode || ev.button !== 0) return;
      const h = this.pick(ev);
      if (!h) return;                    // モデルの外 → 通常の回転
      ev.stopPropagation();
      ev.preventDefault();
      const group = new THREE.Group();
      const line = new THREE.Line(new THREE.BufferGeometry(), lineMat);
      group.add(line);
      this.curveGroup.add(group);
      stroke = { pts: [], disp: [], line, group };
      add(h);
      this.container.setPointerCapture(ev.pointerId);
    }, { capture: true });
    this.container.addEventListener('pointermove', (ev) => {
      if (!stroke) return;
      const h = this.pick(ev);
      if (!h) return;
      const n = stroke.pts.length;
      const last = new THREE.Vector3(stroke.pts[n - 3], stroke.pts[n - 2], stroke.pts[n - 1]);
      if (last.distanceTo(h.p) > this.diag * 0.008) add(h);
    });
    const finish = () => {
      if (!stroke) return;
      const s = stroke;
      stroke = null;
      if (s.pts.length < 6) { this.curveGroup.remove(s.group); return; }
      // 終点に向きの矢印
      const d = s.disp;
      const dir = d[d.length - 1].clone().sub(d[d.length - 2]).normalize();
      const cone = new THREE.Mesh(new THREE.ConeGeometry(this.diag * 0.006, this.diag * 0.018, 12), new THREE.MeshBasicMaterial({ color: 0xffa31a }));
      cone.position.copy(d[d.length - 1]);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      s.group.add(cone);
      this.curves.push({ points: s.pts });
      this.onCurvesChanged();
    };
    this.container.addEventListener('pointerup', finish);
    this.container.addEventListener('pointercancel', finish);
  }
}
