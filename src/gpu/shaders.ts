// GPU パスの GLSL (WebGL2 / GLSL ES 3.00)。three.js の RawShaderMaterial + GLSL3 で使う。
const HEAD = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
`;

export const FULLSCREEN_VS = HEAD + /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// ---- 1. UV 空間への焼き込み: 画素ごとの ワールド位置 / 法線 / dP/du / dP/dv ----
export const BAKE_VS = HEAD + /* glsl */ `
in vec3 position;   // (u, v, 0)
in vec3 aPos;
in vec3 aNrm;
in vec3 aDu;
in vec3 aDv;
in float aStretch;
in float aTri;
flat out float vTri;
out vec3 vPos;
out float vStretch;
out vec3 vNrm;
flat out vec3 vDu;
flat out vec3 vDv;
void main() {
  vPos = aPos; vNrm = aNrm; vDu = aDu; vDv = aDv; vStretch = aStretch; vTri = aTri;
  gl_Position = vec4(position.xy * 2.0 - 1.0, 0.0, 1.0);
}
`;
export const BAKE_FS = HEAD + /* glsl */ `
in vec3 vPos;
in vec3 vNrm;
flat in vec3 vDu;
flat in vec3 vDv;
in float vStretch;
flat in float vTri;
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oNrm;
layout(location = 2) out vec4 oDu;
layout(location = 3) out vec4 oDv;
void main() {
  oPos = vec4(vPos, 1.0);
  oNrm = vec4(normalize(vNrm), vTri);   // w = 三角形の番号(32bit で持つ)
  oDu = vec4(vDu, vStretch);
  oDv = vec4(vDv, 1.0);
}
`;

// ---- 2. パディング: Jump Flooding で最寄りの UV 島の画素を探す ----
export const JFA_INIT_FS = HEAD + /* glsl */ `
uniform sampler2D tPos;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  o = texelFetch(tPos, p, 0).w > 0.5 ? vec4(vec2(p), 0.0, 1.0) : vec4(-1.0);
}
`;
export const JFA_STEP_FS = HEAD + /* glsl */ `
uniform sampler2D tSeed;
uniform int uStep;
uniform int uRes;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 best = texelFetch(tSeed, p, 0);
  float bd = best.x < 0.0 ? 1e20 : dot(best.xy - vec2(p), best.xy - vec2(p));
  for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
    ivec2 q = p + ivec2(dx, dy) * uStep;
    if (q.x < 0 || q.y < 0 || q.x >= uRes || q.y >= uRes) continue;
    vec4 s = texelFetch(tSeed, q, 0);
    if (s.x < 0.0) continue;
    vec2 d = s.xy - vec2(p);
    float dd = dot(d, d);
    if (dd < bd) { bd = dd; best = s; }
  }
  o = best;
}
`;
// 島の外の画素は、最寄りの島の画素から接平面に沿って位置を外挿する。
// これで島の縁の外にも模様が続き、ミップやバイリニアで縁が滲まない。
export const PAD_FS = HEAD + /* glsl */ `
uniform sampler2D tPos;
uniform sampler2D tNrm;
uniform sampler2D tDu;
uniform sampler2D tDv;
uniform sampler2D tSeed;
uniform float uRes;
uniform float uPadMax;
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oNrm;
layout(location = 2) out vec4 oTri;   // x = 画素が乗っている三角形(島の外は最寄りの島の画素のもの)。無ければ -1
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 pos = texelFetch(tPos, p, 0);
  ivec2 s = p;
  vec2 off = vec2(0.0);
  if (pos.w < 0.5) {
    vec4 seed = texelFetch(tSeed, p, 0);
    if (seed.x < 0.0) { oPos = vec4(0.0); oNrm = vec4(0.0); oTri = vec4(-1.0); return; }
    s = ivec2(seed.xy);
    off = vec2(p) - seed.xy;
    float l = length(off);
    if (l > uPadMax) off *= uPadMax / l;
  }
  vec3 du = texelFetch(tDu, s, 0).xyz;
  vec3 dv = texelFetch(tDv, s, 0).xyz;
  vec3 P = texelFetch(tPos, s, 0).xyz + (du * off.x + dv * off.y) / uRes;
  vec4 N4 = texelFetch(tNrm, s, 0);
  vec3 N = normalize(N4.xyz);
  // 1 画素のワールド寸法。三角形ごとの値だと AO 半径やノーマル強度が辺で段差になるので、
  // 頂点で平均した値(焼き込み時に補間済み)を使う
  float texW = texelFetch(tDu, s, 0).w / uRes;
  oPos = vec4(P, pos.w > 0.5 ? 1.0 : 0.0);
  oNrm = vec4(N, texW);
  oTri = vec4(N4.w, 0.0, 0.0, 1.0);
}
`;

// ---- 3. 鱗の敷き詰め(Houdini 版 tiler ラングルの移植) ----
// 画素は「自分が 3D のどこか」を見て近傍の鱗を引くだけなので、UV 島をまたいでも模様が続く。
export const TILER_FS = HEAD + /* glsl */ `
uniform sampler2D tPos;
uniform sampler2D tNrm;
uniform sampler2D tTable;   // バケットごとの (開始, 個数)
uniform sampler2D tS0;      // 鱗: 位置.xyz, 乱数
uniform sampler2D tS1;      // 鱗: 縦方向.xyz, 大きさ倍率
uniform sampler2D tS2;      // 鱗: 横方向.xyz, 禁止ペアを持つか(1/0)
uniform sampler2D tTri;     // 画素が乗っている三角形
uniform sampler2D tForbid;  // 禁止ペア (三角形, 鱗) のハッシュ表。空きは -1
uniform int uForbidW;
uniform uint uForbidMask;
uniform int uUseForbid;
uniform sampler2D tS3;      // 鱗: 法線.xyz, 大きさの倍率(サイズマップ)
uniform sampler2D tTile;
uniform sampler2D tTileH;   // 鱗の高さ画像(任意。タイル画像と同じ配置)
uniform int uHasTileH;
uniform int uTableW;
uniform int uScaleW;
uniform uint uTableMask;
uniform int uBucketCap;     // 1 つのバケットから読む鱗の上限
uniform vec3 uOrigin;
uniform float uCell;
uniform float uRad;
uniform vec2 uTileHalf;     // タイル枠の半幅・半高 [m]
uniform float uTileTexW;    // タイル画像の幅 [px]
uniform float uSgn;
uniform float uHPow;
uniform float uVaria;
uniform int uMaxLayers;
layout(location = 0) out vec4 oCol;   // 鱗の色(premultiplied), a = 被覆
layout(location = 1) out vec4 oAux;   // 高さ, 一番上の鱗の乱数, 被覆, 画素のワールド寸法
layout(location = 2) out vec4 oCtr;   // 一番上の鱗の中心.xyz, 鱗の番号(並べ替え後。無ければ -1)

#define MAXC 16

ivec2 at(int i, int w) { return ivec2(i % w, i / w); }
uint cellHash(ivec3 c) {
  return ((uint(c.x) * 73856093u) ^ (uint(c.y) * 19349663u) ^ (uint(c.z) * 83492791u)) & uTableMask;
}
// 離れた部位の鱗か(三角形 tri にこの鱗 si を描いてはいけないか)
bool forbidden(int tri, int si) {
  uint h = ((uint(tri) * 73856093u) ^ (uint(si) * 19349663u)) & uForbidMask;
  for (int k = 0; k < 64; k++) {
    vec2 e = texelFetch(tForbid, at(int(h), uForbidW), 0).xy;
    if (e.x < 0.0) return false;
    if (int(e.x) == tri && int(e.y) == si) return true;
    h = (h + 1u) & uForbidMask;
  }
  return false;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 P4 = texelFetch(tPos, p, 0);
  vec4 N4 = texelFetch(tNrm, p, 0);
  if (dot(N4.xyz, N4.xyz) < 0.5) { oCol = vec4(0.0); oAux = vec4(0.0); oCtr = vec4(0.0, 0.0, 0.0, -1.0); return; }
  vec3 wp = P4.xyz;
  vec3 wn = normalize(N4.xyz);
  float texW = N4.w;
  int ptri = uUseForbid == 1 ? int(texelFetch(tTri, p, 0).x) : -1;

  ivec3 c0 = ivec3(floor((wp - uOrigin) / uCell));
  uint seen[27];
  int ns = 0;
  int cid[MAXC];
  float clx[MAXC];
  float cly[MAXC];
  float ckey[MAXC];   // 重なり順のキー(大きい順に手前)
  int nc = 0;
  float rad2 = uRad * uRad;

  for (int dz = -1; dz <= 1; dz++) for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
    uint h = cellHash(c0 + ivec3(dx, dy, dz));
    bool dup = false;
    for (int k = 0; k < ns; k++) if (seen[k] == h) dup = true;
    if (dup) continue;
    seen[ns++] = h;
    vec2 sc = texelFetch(tTable, at(int(h), uTableW), 0).xy;
    int st = int(sc.x);
    int cnt = min(int(sc.y), uBucketCap);
    for (int k = 0; k < cnt; k++) {
      int si = st + k;
      vec4 s0 = texelFetch(tS0, at(si, uScaleW), 0);
      vec3 dv = wp - s0.xyz;
      if (dot(dv, dv) > rad2) continue;
      vec4 s3v = texelFetch(tS3, at(si, uScaleW), 0);
      vec3 cn = s3v.xyz;
      if (dot(cn, wn) < 0.2) continue;                    // 裏側の鱗を拾わない
      vec4 s1 = texelFetch(tS1, at(si, uScaleW), 0);
      vec4 s2 = texelFetch(tS2, at(si, uScaleW), 0);
      vec3 cd = s2.xyz;
      float jr = s1.w;
      float lx = dot(dv, cd) / (uTileHalf.x * jr);          // タイル内座標 [-1,1]
      float ly = dot(dv, s1.xyz) / (uTileHalf.y * jr) * uSgn; // +1 = 後縁 / -1 = 根元
      if (abs(lx) > 1.0 || abs(ly) > 1.0) continue;         // 枠の外
      if (s2.w > 0.5 && ptri >= 0 && forbidden(ptri, si)) continue;   // 面をたどると遠い部位の鱗
      // 重なり順のキー = ly × 大きさの倍率 + SIZE_BIAS × (倍率 - 1)。
      // (1) ly は各鱗の大きさで割った座標なので、大きさの違う 2 枚をそのまま比べると画素ごとに上下が入れ替わり、
      //     形が混ざる(実測: 大小の境目の 4.7% が両方の鱗の内側で切れていた)。倍率を掛け戻すと 2 枚のキーの差は
      //     中心どうしの流れ方向の距離だけになり、重なり全体で上下が一定になる(0.1%)。
      // (2) それだけだと、境目で上流側に並んだ小さい鱗が大きい鱗の上半分を覆い、大きい鱗が境目に沿って
      //     直線で切れて見える(実測: 境目の大きい鱗の見える面積が内側の 0.63 倍)。大きさがはっきり違う組は
      //     大きい方を上にする(実際の鱗も大きい鱗の縁が小さい鱗に乗る)。差が小さい組(グラデーション)は流れの順のまま。
      //     SIZE_BIAS 3: 倍率差 0.7 で 2.1 > 流れの項の最大差 2 なので必ず大きい方が上
      // 倍率 1 なら ly そのもの(従来と同じ)
      if (nc < MAXC) { cid[nc] = si; clx[nc] = lx; cly[nc] = ly; ckey[nc] = ly * s3v.w + 3.0 * (s3v.w - 1.0); nc++; }
    }
  }

  // 重なり順: 画素がその鱗の後縁寄り(ly が大きい)ほど上。瓦の規則そのもの。
  for (int i = 1; i < nc; i++) {
    int ci = cid[i]; float xi = clx[i]; float yi = cly[i]; float ki = ckey[i];
    int j = i - 1;
    while (j >= 0 && ckey[j] < ki) { cid[j + 1] = cid[j]; clx[j + 1] = clx[j]; cly[j + 1] = cly[j]; ckey[j + 1] = ckey[j]; j--; }
    cid[j + 1] = ci; clx[j + 1] = xi; cly[j + 1] = yi; ckey[j + 1] = ki;
  }

  vec3 acc = vec3(0.0);
  float acca = 0.0;
  float hacc = 0.0;
  float wsid = -1.0;
  vec3 wctr = wp;
  int wtop = -1;
  int used = 0;
  for (int i = 0; i < nc; i++) {
    if (acca >= 0.995 || used >= uMaxLayers) break;
    vec4 s0 = texelFetch(tS0, at(cid[i], uScaleW), 0);
    float jr = texelFetch(tS1, at(cid[i], uScaleW), 0).w;
    float lx = clx[i];
    float ly = cly[i];
    float idh = s0.w;
    // タイル画像の縮小率からミップを選ぶ(1 枚が数画素しかないときのちらつき防止)
    float lod = max(0.0, log2(uTileTexW * texW / (2.0 * uTileHalf.x * jr)));
    vec4 t = textureLod(tTile, vec2(lx, ly) * 0.5 + 0.5, lod);
    float a = t.a;
    if (a <= 0.002) continue;
    // 高さ: 高さ画像があればそれを、無ければ鱗の形(アルファ)から立ち上げる
    float hh = uHasTileH == 1
      ? textureLod(tTileH, vec2(lx, ly) * 0.5 + 0.5, lod).r
      : pow(clamp(a, 0.0, 1.0), uHPow) * (0.40 + 0.60 * smoothstep(-1.0, 0.90, ly));
    hh *= 1.0 + uVaria * (idh - 0.5);
    // サイズマップ: 小さい鱗は起伏も比例して低くする(テクスチャ上の勾配をそろえる。Houdini 1.1 と同じ)
    hh *= min(texelFetch(tS3, at(cid[i], uScaleW), 0).w, 1.0);
    if (wsid < 0.0) { wsid = idh; wctr = s0.xyz; wtop = cid[i]; }
    acc += (1.0 - acca) * a * t.rgb;
    hacc += (1.0 - acca) * a * hh;
    acca += (1.0 - acca) * a;
    used += 1;
  }
  oCol = vec4(acc, acca);
  oAux = vec4(clamp(hacc, 0.0, 1.0), wsid >= 0.0 ? wsid : 0.0, clamp(acca, 0.0, 1.0), texW);
  oCtr = vec4(wctr, float(wtop));
}
`;

// ---- 4. 高さ → ノーマル(OpenGL 形式 / Unity と同じ +Y) ----
export const NORMAL_FS = HEAD + /* glsl */ `
uniform sampler2D tAux;
uniform int uRes;
uniform float uStrength;
uniform float uSpacing;
out vec4 o;
float h(ivec2 q) { return texelFetch(tAux, clamp(q, ivec2(0), ivec2(uRes - 1)), 0).x; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float texW = texelFetch(tAux, p, 0).w;
  vec3 n = vec3(0.0, 0.0, 1.0);
  if (texW > 0.0) {
    // 鱗 1 枚あたりの画素数で割り戻し、解像度によらず同じ見た目にする
    float k = uStrength * (uSpacing / texW) * 0.5;
    float dx = (h(p + ivec2(1, 0)) - h(p - ivec2(1, 0))) * 0.5;
    float dy = (h(p + ivec2(0, 1)) - h(p - ivec2(0, 1))) * 0.5;
    n = normalize(vec3(-dx * k, -dy * k, 1.0));
  }
  o = vec4(n * 0.5 + 0.5, 1.0);
}
`;

// ---- 5. 高さ → くぼみの AO ----
export const AO_FS = HEAD + /* glsl */ `
uniform sampler2D tAux;
uniform int uRes;
uniform float uSpacing;
out vec4 o;
float h(vec2 q) { return texelFetch(tAux, clamp(ivec2(q), ivec2(0), ivec2(uRes - 1)), 0).x; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 aux = texelFetch(tAux, p, 0);
  float ao = 1.0;
  if (aux.w > 0.0) {
    float r = clamp(0.35 * uSpacing / aux.w, 1.0, 48.0);
    float s = 0.0;
    for (int i = 0; i < 16; i++) {
      float a = float(i) * 0.39269908;
      vec2 d = vec2(cos(a), sin(a));
      s += h(vec2(p) + 0.5 + d * r) + h(vec2(p) + 0.5 + d * r * 0.5);
    }
    s /= 32.0;
    ao = clamp(1.0 - max(0.0, s - aux.x) * 2.5, 0.0, 1.0);
  }
  o = vec4(ao, ao, ao, 1.0);
}
`;

// ---- 6. 着色(Houdini 版 tiler_shade の簡易版) ----
export const SHADE_FS = HEAD + /* glsl */ `
uniform sampler2D tCol;
uniform sampler2D tAux;
uniform sampler2D tCtr;
uniform sampler2D tAO;
uniform int uColorMode;       // 0 = タイルの色 / 1 = 指定色 / 2 = テクスチャから(鱗の中心の色)
uniform sampler2D tScaleCol;  // 鱗ごとの色(並べ替え後の番号順)。a = 1 ならテクスチャから取れた
uniform int uScaleW;
uniform sampler2D tSrc;       // 元の色テクスチャ(隙間の色に使う)
uniform int uHasSrc;
uniform float uRes;
uniform vec3 uTint;
uniform vec3 uGap;            // 鱗の隙間の色
uniform int uGapClear;        // 1 = 隙間を透明にする(a = 鱗の被覆)
uniform float uTileLum;       // タイルの平均明度
uniform float uBriVar;        // 鱗ごとの明るさの差
uniform float uHueVar;        // 鱗ごとの色味の差
uniform float uFleck;         // まだら
uniform float uGroove;        // 溝の暗さ
uniform float uAO;
uniform float uNoiseFreq;
uniform sampler2D tS3;        // 鱗の法線(並べ替え後の番号順)
uniform int uBelly;           // 腹側の色を変えるか
uniform vec3 uBellyCol;
uniform vec3 uBellyDir;       // 腹が向いている方向(ワールド)
uniform float uBellyRange;    // 0 = 腹の真ん中だけ / 1 = 体側まで
out vec4 o;

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 col = texelFetch(tCol, p, 0);
  vec4 aux = texelFetch(tAux, p, 0);
  float mask = aux.z;
  float sid = aux.y;
  vec3 base = col.a > 1e-4 ? col.rgb / col.a : vec3(0.0);
  vec3 gap = uGap;
  if (uColorMode == 1) base = uTint * (lum(base) / max(uTileLum, 1e-3));
  if (uColorMode == 2) {
    // 鱗 1 枚の色 = 中心の位置の元テクスチャの色。タイルの明暗はそのまま掛ける
    int idx = int(texelFetch(tCtr, p, 0).w + 0.5);
    vec4 sc = texelFetch(tCtr, p, 0).w >= 0.0 ? texelFetch(tScaleCol, ivec2(idx % uScaleW, idx / uScaleW), 0) : vec4(0.0);
    vec3 c = sc.a > 0.5 ? sc.rgb : uTint;
    base = c * (lum(base) / max(uTileLum, 1e-3));
    // 隙間はその画素の元の色を暗くしたもの(模様が隙間でも途切れない)
    if (uHasSrc == 1) gap = texture(tSrc, (vec2(p) + 0.5) / uRes).rgb * 0.4;
  }

  // 背と腹の塗り分け: 一番上の鱗の法線で決めるので、境目も鱗 1 枚単位で切り替わる。
  // 境目の鱗は乱数で少しずらして、直線的な境界にならないようにする
  if (uBelly == 1 && uColorMode != 2) {
    float fi = texelFetch(tCtr, p, 0).w;
    if (fi >= 0.0) {
      int idx = int(fi + 0.5);
      vec3 sn = texelFetch(tS3, ivec2(idx % uScaleW, idx / uScaleW), 0).xyz;
      float t0 = mix(0.75, -0.35, uBellyRange);
      float w = smoothstep(t0 - 0.12, t0 + 0.12, dot(sn, uBellyDir) + (sid - 0.5) * 0.3);
      base = mix(base, uBellyCol * (lum(base) / max(lum(uColorMode == 1 ? uTint : vec3(uTileLum)), 1e-3)), w);
    }
  }

  float m = mask > 0.5 ? 1.0 : 0.0;
  base *= 1.0 + uBriVar * (sid - 0.5) * 2.0 * m;
  base = mix(base, base * vec3(0.80, 1.07, 0.88), sid * uHueVar * m);

  // まだら: 鱗単位の濃淡。鱗の中心で低周波ノイズを引いて塊にする
  if (m > 0.0 && uFleck > 0.0) {
    float f2 = fract(sid * 97.13);
    float cluster = vnoise(texelFetch(tCtr, p, 0).xyz * uNoiseFreq);
    float pdark = (0.05 + 0.24 * smoothstep(0.42, 0.72, cluster)) * uFleck;
    if (f2 < pdark) base *= 0.52;
    else if (f2 > 1.0 - 0.045 * uFleck) base *= 1.30;
  }

  // 溝の判定は「倍率を掛ける前の高さ」で行う。サイズマップで小さくした鱗は起伏を min(s,1) 倍に下げているので、
  // そのままの高さで判定すると面全体が溝扱いになって暗くなる(実測: 0.5 倍の側の平均明度 66 / 1 倍の側 106)
  float hN = aux.x;
  float topIdx = texelFetch(tCtr, p, 0).w;
  if (topIdx >= 0.0) {
    int ti = int(topIdx + 0.5);
    float ss = texelFetch(tS3, ivec2(ti % uScaleW, ti / uScaleW), 0).w;
    hN = aux.x / max(min(ss, 1.0), 1e-3);
  }
  float groove = 1.0 - smoothstep(0.33, 0.72, hN);
  base *= 1.0 - groove * uGroove * 0.75 * mask;
  base *= mix(1.0, texelFetch(tAO, p, 0).x, 0.6 * uAO);
  if (uGapClear == 1) {
    // 透明にするときは a = 被覆。半透明の縁は鱗の色のまま a だけ下げる(隙間の色を混ぜると縁が黒ずむ)
    o = vec4(clamp(mask > 1e-3 ? base : gap, 0.0, 1.0), mask);
    return;
  }
  vec3 c = base * mask + gap * (1.0 - mask);
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;
