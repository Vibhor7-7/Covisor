/**
 * TalkingBlob: an audio-reactive "talking" opal blob.
 * Zero dependencies. WebGL2 renders it, Web Audio listens to it.
 *
 *   import { TalkingBlob } from './talking-blob.js';
 *   const blob = new TalkingBlob(document.getElementById('blob'));
 *   blob.listen(stream);        // MediaStream (mic), HTMLMediaElement, or AudioNode
 *
 * Why it looks like talking and not just pulsing:
 * every frame the audio is reduced to speech-shaped features.
 *   level   loudness, auto-gained              -> swell + surface wobble + halo
 *   open    F1 position (jaw openness, "ah")   -> vertical stretch
 *   front   F2 position (lip spread, "ee")     -> horizontal stretch
 *   hiss    4-10 kHz share ("s", "sh", "f")    -> rim glint + fine shimmer
 *   onset   spectral flux (syllable attacks)   -> jelly pokes on damped springs
 *   warmth  spectral centroid                  -> peach light swings forward
 *
 * Colors follow a smooth "base" surface; the fast speech texture only moves
 * light and shade. That keeps the matte opal gradient calm while it talks.
 */

// ---------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------

// Colored "lights" in view space (x right, y up, z toward viewer).
// The surface color is a soft blend of these, picked by the surface normal,
// which is what gives the matte opal gradient from the reference.
export const OPAL_PALETTE = [
  { dir: [-0.25, 0, 1], color: '#6aaed6' },      // front: sky blue
  { dir: [-1, 0.15, 0.3], color: '#adc9d7' },    // left: pale mist
  { dir: [-0.75, -0.6, 0.3], color: '#7fcbe8' }, // lower left: cyan
  { dir: [1, -0.05, 0.55], color: '#8890cc' },   // right: periwinkle
  { dir: [0.82, 0.6, 0.12], color: '#ff8d4f' },  // top right: peach (index 4, the "warm" light)
  { dir: [-0.3, 1, 0.2], color: '#a3989c' },     // top: mauve grey
  { dir: [0.55, -0.85, 0.25], color: '#bca482' },// bottom right: sand
  { dir: [-0.15, -1, 0.3], color: '#a4c1cf' },   // bottom: mist
];

const DEFAULTS = {
  palette: OPAL_PALETTE,
  rim: '#dfe5f2',      // silhouette tint, close to the page background
  glow: 0.55,          // halo strength while talking (0 = off)
  reactivity: 1,       // overall audio response
  detail: 6,           // icosphere subdivisions (5 for low-end mobile)
  pointer: true,       // tilt toward the cursor, click to poke
  audioContext: null,  // pass your own if your audio graph already has one
};

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

// 3D simplex noise. Ashima Arts / Stefan Gustavson, MIT license.
const NOISE = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(
    i.z+vec4(0.0,i1.z,i2.z,1.0))
    +i.y+vec4(0.0,i1.y,i2.y,1.0))
    +i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const BLOB_VERT = `#version 300 es
precision highp float;
in vec3 aPos;
uniform mat4 uProj;
uniform mat3 uRot;
uniform vec3 uStretch;
uniform float uScale, uCamZ, uTime, uFreq, uMorph, uWobble, uRipple, uRippleTime;
uniform vec4 uPokes[4];
uniform vec4 uOutline; // x: 3-fold amount, y: its angle, z: 2-fold amount, w: its angle
out vec3 vNormal;
out vec3 vBaseNormal;
out vec3 vViewPos;
out vec3 vObj;
${NOISE}
// Radial offset of the surface along direction p (unit vector).
// "base" is the big, smooth shape that the colors follow.
float shapeBase(vec3 p){
  // Outline: three soft lobes with gentle dips between them (the reference's
  // trefoil), built in view space so it always faces the camera.
  // x^3 - 3xy^2 is r^3 cos(3 phi): smooth everywhere, zero at the front and back.
  vec3 v = uRot * p;
  vec2 a = vec2(cos(uOutline.y), sin(uOutline.y));
  vec2 t3 = vec2(dot(v.xy, a), dot(v.xy, vec2(-a.y, a.x)));
  float d = uOutline.x * (t3.x * t3.x * t3.x - 3.0 * t3.x * t3.y * t3.y);
  vec2 b2 = vec2(cos(uOutline.w), sin(uOutline.w));
  vec2 t2 = vec2(dot(v.xy, b2), dot(v.xy, vec2(-b2.y, b2.x)));
  d += uOutline.z * (t2.x * t2.x - t2.y * t2.y);
  vec3 q = p * uFreq;
  d += snoise(q + vec3(0.0, uTime*0.11, uTime*0.07)) * uMorph;               // slow organic drift
  d += snoise(q*2.0 + vec3(uTime*0.23, -uTime*0.17, 4.0)) * uMorph * 0.25;
  for (int i = 0; i < 4; i++) {                                               // syllable pokes
    d += uPokes[i].w * exp((dot(p, uPokes[i].xyz) - 1.0) * 3.5);
  }
  return d;
}
// "detail" is the fast speech texture: it moves light and shade, not color.
float shapeDetail(vec3 p){
  vec3 q = p * uFreq;
  float d = snoise(q*1.7 + vec3(-uTime*0.5, uTime*0.4, 9.0)) * uWobble;     // speech wobble
  d += snoise(q*3.2 + vec3(0.0, uRippleTime, 17.0)) * uRipple;               // sibilance shimmer
  return d;
}
vec3 place(vec3 p, float d){
  return uStretch * (uRot * (p * (1.0 + d))) * uScale;
}
void main(){
  vec3 p0 = normalize(aPos);
  vec3 up = abs(p0.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(up, p0));
  const float e = 0.012;
  vec3 p1 = normalize(p0 + t * e);
  vec3 p2 = normalize(p0 + cross(p0, t) * e);
  float b0 = shapeBase(p0), b1 = shapeBase(p1), b2 = shapeBase(p2);
  float d0 = b0 + shapeDetail(p0), d1 = b1 + shapeDetail(p1), d2 = b2 + shapeDetail(p2);
  vec3 w0 = place(p0, d0);
  vNormal = normalize(cross(place(p1, d1) - w0, place(p2, d2) - w0));      // the real surface
  vec3 c0 = place(p0, b0);
  vBaseNormal = normalize(cross(place(p1, b1) - c0, place(p2, b2) - c0));  // the smooth surface
  vViewPos = w0 - vec3(0.0, 0.0, uCamZ);
  vObj = p0;
  gl_Position = uProj * vec4(vViewPos, 1.0);
}`;

const BLOB_FRAG = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vBaseNormal;
in vec3 vViewPos;
in vec3 vObj;
uniform vec3 uDirs[8];
uniform vec3 uCols[8];
uniform vec3 uRim;
uniform float uSharp, uTime, uLevel, uHiss, uEdge, uWarp, uWarpFreq, uRimMix;
out vec4 outColor;
${NOISE}
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main(){
  vec3 N = normalize(vNormal);
  vec3 B = normalize(vBaseNormal);
  vec3 V = normalize(-vViewPos);
  float ndv = clamp(dot(N, V), 0.0, 1.0);

  // Warp the lookup normal with noise that lives on the surface, so the
  // gradient flows organically instead of looking like plain lighting.
  vec3 q = vObj * uWarpFreq;
  vec3 w = vec3(snoise(q + vec3(0.0, 0.0, uTime*0.05)),
                snoise(q + vec3(7.1, 0.0, -uTime*0.05)),
                snoise(q + vec3(0.0, 13.7, uTime*0.04)));
  vec3 L = normalize(B + w * uWarp);

  vec3 col = vec3(0.0);
  float ws = 0.0;
  for (int i = 0; i < 8; i++) {
    float k = exp(uSharp * (dot(L, uDirs[i]) - 1.0));
    col += uCols[i] * k;
    ws += k;
  }
  col /= ws;

  // Speech texture shows as soft light and shade from a key light (upper left).
  const vec3 K = vec3(-0.45, 0.6, 0.66);
  col *= 1.0 + 0.7 * (dot(N, K) - dot(B, K));

  col += vec3(0.04, 0.035, 0.03) * uLevel * pow(ndv, 3.0); // inner light while talking
  float fr = pow(1.0 - ndv, 3.0);
  col = mix(col, uRim + 0.12 * uHiss, fr * (uRimMix + 0.6 * uHiss)); // rim, glints on s and sh
  float a = smoothstep(0.0, uEdge, ndv);                     // feathered silhouette
  col += (ign(gl_FragCoord.xy) - 0.5) / 255.0;               // dither: no banding
  outColor = vec4(col * a, a);
}`;

const GLOW_VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const GLOW_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec2 uAspect;
uniform float uRadius, uStrength;
uniform vec3 uColA, uColB;
out vec4 outColor;
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main(){
  vec2 s = vUv * uAspect;                      // 1.0 = edge of the shorter side
  vec2 p = s / uRadius;                        // 1.0 = blob radius
  float r = length(p);
  float a = uStrength * exp(-r * r * 0.9) * smoothstep(1.0, 0.7, length(s));
  vec3 col = mix(uColA, uColB, clamp(0.5 + p.x * 0.35 + p.y * 0.35, 0.0, 1.0));
  a = clamp(a + (ign(gl_FragCoord.xy) - 0.5) / 255.0, 0.0, 1.0);
  outColor = vec4(col * a, a);
}`;

// ---------------------------------------------------------------------------
// Audio analysis
// ---------------------------------------------------------------------------

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ease = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

class VoiceAnalyser {
  constructor(ctx) {
    this.node = ctx.createAnalyser();
    this.node.fftSize = 2048;
    this.node.smoothingTimeConstant = 0; // we smooth per feature instead
    this.binHz = ctx.sampleRate / this.node.fftSize;
    this.db = new Float32Array(this.node.frequencyBinCount);
    this.pow = new Float32Array(this.node.frequencyBinCount);
    this.prevDb = new Float32Array(this.node.frequencyBinCount).fill(-100);
    this.wave = new Float32Array(this.node.fftSize);
    this.peakDb = -30;
    this.fluxAvg = 0;
    this.lastOnset = 0;
    this.features = { level: 0, open: 0.4, front: 0.4, hiss: 0, warmth: 0.3, onset: 0 };
  }

  _sum(lo, hi, weighted) {
    const a = Math.max(1, Math.round(lo / this.binHz));
    const b = Math.min(this.pow.length - 1, Math.round(hi / this.binHz));
    let s = 0, sw = 0;
    for (let i = a; i <= b; i++) { s += this.pow[i]; sw += this.pow[i] * i * this.binHz; }
    return weighted ? (s > 0 ? sw / s : (lo + hi) / 2) : s;
  }

  update(dt, now) {
    const f = this.features;
    this.node.getFloatTimeDomainData(this.wave);
    let ms = 0;
    for (let i = 0; i < this.wave.length; i++) ms += this.wave[i] * this.wave[i];
    const db = 10 * Math.log10(ms / this.wave.length + 1e-12);

    // Auto gain: loudness is measured against a slowly falling recent peak,
    // so a quiet laptop mic and a loud podcast both use the full range.
    this.peakDb = Math.max(db, this.peakDb - 4 * dt, -34);
    const gate = this.peakDb - 36;
    const raw = Math.pow(clamp01((db - gate) / (this.peakDb - gate)), 1.7);
    f.level = ease(f.level, raw, raw > f.level ? 30 : 7, dt); // fast attack, soft release

    this.node.getFloatFrequencyData(this.db);
    let flux = 0, n = 0;
    const fluxTop = Math.round(5000 / this.binHz);
    for (let i = 0; i < this.db.length; i++) {
      const d = Math.max(this.db[i], -100);
      this.pow[i] = Math.pow(10, d / 10);
      if (i > 1 && i < fluxTop) { flux += Math.max(0, d - this.prevDb[i]); n++; }
      this.prevDb[i] = d;
    }
    flux /= n;

    const voiced = raw > 0.12;
    if (voiced) {
      // F1 (250-1000 Hz) rises as the jaw opens: "ee" ~300 Hz, "ah" ~850 Hz.
      const f1 = this._sum(250, 1000, true);
      // F2 (800-3300 Hz) rises as the tongue moves forward: "oo" ~950, "ee" ~2800.
      const f2 = this._sum(800, 3300, true);
      f.open = ease(f.open, clamp01((f1 - 420) / 330), 14, dt);
      f.front = ease(f.front, clamp01((f2 - 1350) / 1050), 14, dt);
    } else {
      f.open = ease(f.open, 0.4, 3, dt);
      f.front = ease(f.front, 0.4, 3, dt);
    }

    // Hiss: high band (fricatives) against the voice band, in dB.
    const hi = this._sum(4000, 10000), lo = this._sum(100, 4000);
    const ratio = 10 * Math.log10((hi + 1e-12) / (lo + 1e-12));
    const hiss = raw > 0.05 ? clamp01((ratio + 14) / 14) : 0;
    f.hiss = ease(f.hiss, hiss, hiss > f.hiss ? 25 : 8, dt);

    const centroid = this._sum(100, 8000, true);
    f.warmth = ease(f.warmth, voiced ? clamp01((centroid - 600) / 2200) : 0.3, 2.5, dt);

    // Syllable onsets: spectral flux jumping above its running average.
    f.onset = 0;
    if (flux > this.fluxAvg * 1.7 + 1.2 && raw > 0.18 && now - this.lastOnset > 0.11) {
      f.onset = clamp01((flux - this.fluxAvg) / 9);
      this.lastOnset = now;
    }
    this.fluxAvg = ease(this.fluxAvg, flux, 2.5, dt);
    return f;
  }
}

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
  const sx = aspect >= 1 ? f / aspect : f;   // fit the blob to the shorter side
  const sy = aspect >= 1 ? f : f * aspect;
  return new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

// R = Ry(yaw) * Rx(pitch), column-major.
function rotation(yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cx = Math.cos(pitch), sx = Math.sin(pitch);
  return new Float32Array([cy, 0, -sy, sy * sx, cx, cy * sx, sy * cx, -sx, cy * cx]);
}

function icosphere(detail) {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
    [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(norm3);
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4],
    [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let d = 0; d < detail; d++) {
    const cache = new Map(), next = [];
    const mid = (a, b) => {
      const key = a < b ? a * 1e6 + b : b * 1e6 + a;
      let i = cache.get(key);
      if (i === undefined) {
        const A = verts[a], B = verts[b];
        i = verts.push(norm3([A[0] + B[0], A[1] + B[1], A[2] + B[2]])) - 1;
        cache.set(key, i);
      }
      return i;
    };
    for (const [a, b, c] of faces) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  const pos = new Float32Array(verts.length * 3);
  verts.forEach((v, i) => pos.set(v, i * 3));
  const idx = new Uint32Array(faces.length * 3);
  faces.forEach(([a, b, c], i) => {
    const A = verts[a], B = verts[b], C = verts[c];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const outward = n[0] * A[0] + n[1] * A[1] + n[2] * A[2] > 0;
    idx.set(outward ? [a, b, c] : [a, c, b], i * 3);
  });
  return { pos, idx };
}

function program(gl, vs, fs) {
  const make = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS), u = {};
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace('[0]', '');
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

// Damped spring: under-damped on purpose, so the blob overshoots like jelly.
const spring = (s, k, c, dt) => { s.v += (-k * (s.x - s.target) - c * s.v) * dt; s.x += s.v * dt; };

// ---------------------------------------------------------------------------
// TalkingBlob
// ---------------------------------------------------------------------------

const FOV = (24 * Math.PI) / 180;
const CAM_Z = 6.6;
const SILENT = { level: 0, open: 0.4, front: 0.4, hiss: 0, warmth: 0.3, onset: 0 };

export class TalkingBlob {
  constructor(container, options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'display:block;width:100%;height:100%';
    container.appendChild(this.canvas);

    const gl = this.canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true });
    if (!gl) throw new Error('TalkingBlob needs WebGL2.');
    this.gl = gl;

    this.blobProg = program(gl, BLOB_VERT, BLOB_FRAG);
    this.glowProg = program(gl, GLOW_VERT, GLOW_FRAG);

    const { pos, idx } = icosphere(this.opts.detail);
    this.count = idx.length;
    this.blobVao = gl.createVertexArray();
    gl.bindVertexArray(this.blobVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(this.blobProg.p, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

    this.glowVao = gl.createVertexArray();
    gl.bindVertexArray(this.glowVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const gPos = gl.getAttribLocation(this.glowProg.p, 'aPos');
    gl.enableVertexAttribArray(gPos);
    gl.vertexAttribPointer(gPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.setPalette(this.opts.palette, this.opts.rim);

    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.state = {
      swell: { x: 1, v: 0, target: 1 },
      sx: { x: 1, v: 0, target: 1 },
      sy: { x: 1, v: 0, target: 1 },
      sz: { x: 1, v: 0, target: 1 },
      pokes: Array.from({ length: 4 }, () => ({ dir: [0, 0, 1], x: 0, v: 0, target: 0 })),
      wobble: 0.012, ripple: 0, hiss: 0, glow: 0, level: 0, warm: 0.3,
      tNoise: Math.random() * 50, tRipple: 0, phase: Math.random() * 10,
      yaw: Math.random() * 6, tiltX: 0, tiltY: 0, aimX: 0, aimY: 0,
    };
    // Shape and shading knobs. Safe to tweak live: blob.look.morph = 0.2
    this.look = {
      lobes: 0.12,                  // three soft lobes in the outline (0 = round)
      freq: 0.55, morph: 0.06,      // slow organic noise on top
      sharp: 5.5,                   // color blend: lower = softer, higher = more distinct zones
      warp: 0.12, warpFreq: 0.7,    // how much the gradient swirls
      edge: 0.22, rimMix: 0.3,      // silhouette feather and rim tint
    };
    this.pokeData = new Float32Array(16);
    this.dirData = new Float32Array(24);

    this._alive = true;
    this._visible = true;
    this._last = 0;
    this._fit();
    this._ro = new ResizeObserver(() => this._fit());
    this._ro.observe(container);
    this._io = new IntersectionObserver(([e]) => {
      this._visible = e.isIntersecting;
      if (this._visible && !this._raf) { this._last = 0; this._raf = requestAnimationFrame(this._frame); }
    });
    this._io.observe(container);

    if (this.opts.pointer) {
      this._onMove = (e) => {
        const r = this.canvas.getBoundingClientRect();
        this.state.aimX = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
        this.state.aimY = Math.max(-1, Math.min(1, 1 - ((e.clientY - r.top) / r.height) * 2));
      };
      this._onDown = (e) => this._pointerPoke(e);
      window.addEventListener('pointermove', this._onMove, { passive: true });
      this.canvas.addEventListener('pointerdown', this._onDown);
    }

    this._raf = requestAnimationFrame(this._frame);
  }

  /** Start reacting to a MediaStream (mic), an <audio>/<video> element, or any AudioNode. */
  listen(source) {
    if (!this.audioContext) {
      this.audioContext = this.opts.audioContext || new AudioContext();
      this._ownsContext = !this.opts.audioContext;
    }
    const ctx = this.audioContext;
    if (!this.analyser) this.analyser = new VoiceAnalyser(ctx);
    this.unlisten();
    let node;
    if (source instanceof MediaStream) {
      node = ctx.createMediaStreamSource(source);          // not routed to speakers: no feedback
    } else if (source instanceof HTMLMediaElement) {
      this._elements = this._elements || new WeakMap();    // an element can only be wrapped once
      node = this._elements.get(source);
      if (!node) { node = ctx.createMediaElementSource(source); this._elements.set(source, node); }
      node.connect(ctx.destination);                       // keep it audible
    } else if (source && typeof source.connect === 'function') {
      node = source;                                       // your node, your routing
    } else {
      throw new Error('listen() takes a MediaStream, an HTMLMediaElement or an AudioNode.');
    }
    node.connect(this.analyser.node);
    this._input = node;
    if (ctx.state === 'suspended') ctx.resume();
    return this;
  }

  /** Stop reacting. The blob drifts back to idle. */
  unlisten() {
    if (this._input) {
      try { this._input.disconnect(this.analyser.node); } catch { /* already gone */ }
      this._input = null;
    }
    return this;
  }

  /** Latest speech features, each 0..1. Handy for debugging or extra UI. */
  get features() {
    return this._input && this.analyser ? this.analyser.features : SILENT;
  }

  /** Swap colors. palette: [{ dir: [x,y,z], color: '#hex' }] x8, view space. */
  setPalette(palette, rim = this.opts.rim) {
    if (palette.length !== 8) throw new Error('Palette needs exactly 8 entries.');
    this.palette = palette.map((p) => ({ dir: norm3(p.dir), color: hexToRgb(p.color) }));
    this.colData = new Float32Array(this.palette.flatMap((p) => p.color));
    this.rim = hexToRgb(rim);
    return this;
  }

  /** Dent the blob at a point in view space (x, y in -1..1 of the blob's disc). */
  poke(x, y, amount = -0.22) {
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    this._kick(norm3([x, y, z]), amount);
  }

  destroy() {
    this._alive = false;
    cancelAnimationFrame(this._raf);
    this._ro.disconnect();
    this._io.disconnect();
    if (this._onMove) window.removeEventListener('pointermove', this._onMove);
    this.unlisten();
    if (this._ownsContext) this.audioContext.close();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
  }

  // -------------------------------------------------------------------------

  _fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.container.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.container.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.aspect = w / h;
    this.proj = perspective(FOV, this.aspect, 0.1, 50);
  }

  _pointerPoke(e) {
    const r = this.canvas.getBoundingClientRect();
    const minSide = Math.min(r.width, r.height);
    const blobPx = (minSide / 2) / (CAM_Z * Math.tan(FOV / 2)); // blob radius in CSS px
    const x = (e.clientX - (r.left + r.width / 2)) / blobPx;
    const y = -(e.clientY - (r.top + r.height / 2)) / blobPx;
    if (x * x + y * y > 1.1) return;
    this.poke(Math.max(-0.95, Math.min(0.95, x)), Math.max(-0.95, Math.min(0.95, y)));
  }

  // dirView is in view space; pokes live in object space so they ride the rotation.
  _kick(dirView, amount) {
    const R = this._rot || rotation(this.state.yaw, 0);
    const d = norm3([
      R[0] * dirView[0] + R[1] * dirView[1] + R[2] * dirView[2],
      R[3] * dirView[0] + R[4] * dirView[1] + R[5] * dirView[2],
      R[6] * dirView[0] + R[7] * dirView[1] + R[8] * dirView[2],
    ]);
    let slot = this.state.pokes[0];
    for (const p of this.state.pokes) if (Math.abs(p.x) + Math.abs(p.v) * 0.1 < Math.abs(slot.x) + Math.abs(slot.v) * 0.1) slot = p;
    slot.dir = d;
    slot.v += amount * 9;
  }

  _frame = (ms) => {
    this._raf = 0;
    if (!this._alive) return;
    const t = ms / 1000;
    const dt = this._last ? Math.min(0.05, t - this._last) : 1 / 60;
    this._last = t;
    const f = this._input && this.analyser ? this.analyser.update(dt, t) : SILENT;
    for (let left = dt; left > 1e-4; left -= 1 / 120) this._step(Math.min(left, 1 / 120), t, f);
    if (f.onset > 0) this._onset(f.onset);
    this._draw();
    if (this._visible) this._raf = requestAnimationFrame(this._frame);
  };

  _onset(strength) {
    // A random spot on the front half of the blob gets a soft push outwards.
    const a = Math.random() * Math.PI * 2, r = 0.35 + Math.random() * 0.5;
    const R = this.opts.reactivity * (this.reduced ? 0.4 : 1);
    this._kick(norm3([Math.cos(a) * r, Math.sin(a) * r, Math.sqrt(1 - r * r)]), (0.05 + 0.11 * strength) * R);
  }

  _step(dt, t, f) {
    const s = this.state;
    const R = this.opts.reactivity * (this.reduced ? 0.4 : 1);
    const L = Math.min(1.2, f.level * R);
    s.level = ease(s.level, f.level, 10, dt);
    const open = f.open * f.level, front = f.front * f.level;

    s.swell.target = 1 + 0.012 * Math.sin(t * 1.15) + 0.085 * L;     // breathing + loudness
    s.sy.target = 1 + (0.17 * open - 0.05 * front) * R;               // "ah" stretches tall
    s.sx.target = 1 + (0.15 * front - 0.06 * open) * R;               // "ee" stretches wide
    s.sz.target = 1 - 0.05 * (open + front) * R;
    spring(s.swell, 220, 14, dt);
    spring(s.sx, 160, 11, dt);
    spring(s.sy, 160, 11, dt);
    spring(s.sz, 160, 11, dt);
    for (const p of s.pokes) spring(p, 70, 4.5, dt);

    const wob = 0.012 + 0.06 * L;
    s.wobble = ease(s.wobble, wob, wob > s.wobble ? 12 : 3, dt);
    s.hiss = ease(s.hiss, f.hiss * Math.min(1, f.level * 1.5), 14, dt);
    s.ripple = ease(s.ripple, 0.01 * f.hiss * Math.min(1, f.level * 1.5) * R, 14, dt);
    s.glow = ease(s.glow, L, L > s.glow ? 8 : 2.5, dt);
    s.warm = ease(s.warm, f.warmth, 3, dt);

    const motion = this.reduced ? 0.35 : 1;
    s.tNoise += dt * (1 + 2.4 * L) * motion;
    s.tRipple += dt * (2.5 + 7 * f.hiss) * motion;
    s.phase += dt * (0.12 + 0.6 * L) * motion;
    s.yaw += dt * 0.07 * motion;

    const follow = this.opts.pointer && !this.reduced;
    s.tiltX = ease(s.tiltX, follow ? -s.aimY * 0.28 : 0, 3, dt);
    s.tiltY = ease(s.tiltY, follow ? s.aimX * 0.4 : 0, 3, dt);
  }

  _draw() {
    const gl = this.gl, s = this.state;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const radius = 1 / (CAM_Z * Math.tan(FOV / 2));
    const glow = this.opts.glow * s.glow;
    if (glow > 0.002) {
      const g = this.glowProg;
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(g.p);
      gl.uniform2f(g.u.uAspect, this.aspect >= 1 ? this.aspect : 1, this.aspect >= 1 ? 1 : 1 / this.aspect);
      gl.uniform1f(g.u.uRadius, radius * s.swell.x);
      gl.uniform1f(g.u.uStrength, glow * 0.45);
      gl.uniform3fv(g.u.uColA, this.palette[0].color);
      gl.uniform3fv(g.u.uColB, this.palette[4].color);
      gl.bindVertexArray(this.glowVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // Color lights sway gently; while talking they sway faster and the warm
    // light swings toward the front as the voice gets brighter.
    for (let i = 0; i < 8; i++) {
      let [x, y, z] = this.palette[i].dir;
      const a = 0.32 * Math.sin(s.phase + i * 1.7);
      const ca = Math.cos(a), sa = Math.sin(a);
      [x, y] = [x * ca - y * sa, x * sa + y * ca];
      if (i === 4) [x, y, z] = norm3([x, y, z + s.warm * s.level * 0.8]);
      this.dirData.set([x, y, z], i * 3);
    }
    s.pokes.forEach((p, i) => this.pokeData.set([p.dir[0], p.dir[1], p.dir[2], p.x], i * 4));
    this._rot = rotation(s.yaw + s.tiltY, s.tiltX);

    // The outline's lobes drift a little so it never looks stamped.
    const T = s.tNoise;
    this.outline = [
      this.look.lobes * (1 + 0.15 * Math.sin(T * 0.21)),
      Math.PI / 6 + 0.16 * Math.sin(T * 0.13) + 0.08 * Math.sin(T * 0.31),
      this.look.lobes * 0.25 * (0.6 + 0.4 * Math.sin(T * 0.17)),   // slightly wider than tall
      0.25 * Math.sin(T * 0.07),
    ];

    const b = this.blobProg;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.useProgram(b.p);
    gl.uniformMatrix4fv(b.u.uProj, false, this.proj);
    gl.uniformMatrix3fv(b.u.uRot, false, this._rot);
    gl.uniform3f(b.u.uStretch, s.sx.x, s.sy.x, s.sz.x);
    gl.uniform1f(b.u.uScale, s.swell.x);
    gl.uniform1f(b.u.uCamZ, CAM_Z);
    gl.uniform1f(b.u.uTime, s.tNoise);
    gl.uniform4fv(b.u.uOutline, this.outline);
    gl.uniform1f(b.u.uFreq, this.look.freq);
    gl.uniform1f(b.u.uMorph, this.look.morph);
    gl.uniform1f(b.u.uWobble, s.wobble);
    gl.uniform1f(b.u.uRipple, s.ripple);
    gl.uniform1f(b.u.uRippleTime, s.tRipple);
    gl.uniform4fv(b.u.uPokes, this.pokeData);
    gl.uniform3fv(b.u.uDirs, this.dirData);
    gl.uniform3fv(b.u.uCols, this.colData);
    gl.uniform3fv(b.u.uRim, this.rim);
    gl.uniform1f(b.u.uSharp, this.look.sharp);
    gl.uniform1f(b.u.uWarp, this.look.warp);
    gl.uniform1f(b.u.uWarpFreq, this.look.warpFreq);
    gl.uniform1f(b.u.uRimMix, this.look.rimMix);
    gl.uniform1f(b.u.uLevel, s.level);
    gl.uniform1f(b.u.uHiss, s.hiss);
    gl.uniform1f(b.u.uEdge, this.look.edge);
    gl.bindVertexArray(this.blobVao);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }
}
