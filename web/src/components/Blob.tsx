import { useEffect, useRef } from "react";
import * as audio from "../audio";
import { useCall } from "../call/call";
import { useStore } from "../store";

const SILENCE = new Uint8Array(0);

const VERTEX = `
attribute vec2 corner;
void main() { gl_Position = vec4(corner, 0.0, 1.0); }
`;

// An opal: a soft 3D body with colour drifting under its skin. The surface is
// a sphere whose radius swells by direction, so the point over each pixel can
// be solved in three steps instead of marched to. Lengths are in blob radii.
const FRAGMENT = `
precision highp float;

uniform vec2 uSize;
uniform float uRadius;  // device pixels
uniform float uTime;    // drives the shape
uniform float uFlow;    // drives the colour
uniform float uSpin;    // turns the whole body
uniform float uLevel;   // loudness of whoever is talking, 0..1
uniform vec3 uBands;    // speech energy: low, mid, high
uniform float uWarm;    // 0 = cool and listening, 1 = warm and speaking
uniform float uDark;    // 1 on a dark page

const float BOUND = 1.6;
const vec3 SKY = vec3(0.36, 0.72, 0.98);
const vec3 PERI = vec3(0.52, 0.52, 0.96);
const vec3 PEACH = vec3(1.00, 0.56, 0.32);
const vec3 ROSE = vec3(1.00, 0.55, 0.78);
const vec3 PEARL = vec3(0.95, 0.94, 1.00);

// A smooth field with no grid and no seams. Its slope reuses the same sines
// and cosines, which is what makes exact surface normals nearly free.
float gyroid(vec3 q, out vec3 slope) {
  vec3 s = sin(q);
  vec3 c = cos(q);
  slope = c * c.yzx - s.zxy * s;
  return dot(s, c.yzx);
}

// How far the surface reaches in one direction, and how that changes nearby.
// Low notes move the big lobes; sharper sounds add the finer folds.
float reach(vec3 dir, out vec3 slope) {
  vec3 big;
  vec3 fine;
  float lobes = gyroid(dir * 2.2 + vec3(0.0, uTime * 0.33, uTime * 0.2), big);
  float folds = gyroid(dir * 3.6 - vec3(uTime * 0.4, 0.0, uTime * 0.27) + 2.0, fine);
  float tall = 0.095 + 0.11 * uBands.x;
  float small = 0.04 + 0.07 * uBands.y + 0.035 * uBands.z;
  slope = big * (tall * 2.2) + fine * (small * 3.6);
  return 1.0 + 0.06 * uLevel + lobes * tall + folds * small;
}

// Pigments folded into each other. Warmth decides how far peach and rose spread
// through the blues.
vec3 opal(vec3 q) {
  q += 0.5 * sin(q.yzx * 2.1 + uFlow * 0.55);
  q += 0.3 * sin(q.zxy * 3.4 - uFlow * 0.38 + 1.3);
  float a = 0.5 + 0.5 * sin(q.x * 2.3 + q.y * 1.1 + uFlow * 0.27);
  float b = 0.5 + 0.5 * sin(q.y * 2.0 - q.z * 1.6 + 2.1 - uFlow * 0.22);
  float c = 0.5 + 0.5 * sin(q.z * 2.6 + q.x * 1.3 + 4.2 + uFlow * 0.18);
  vec3 cool = mix(SKY, PERI, a);
  vec3 warm = mix(PEACH, ROSE, c);
  vec3 ink = mix(cool, warm, smoothstep(0.7 - 0.55 * uWarm, 1.0 - 0.45 * uWarm, b));
  ink = mix(ink, PEARL, 0.5 * smoothstep(0.55, 0.95, a * (1.0 - c) + 0.2 * b));
  // Thin veins of pearl, so the colour reads as depth rather than paint.
  return mix(ink, PEARL, 0.16 * smoothstep(0.55, 1.0, sin(q.x * 4.6 + q.z * 3.9 + uFlow * 0.45)));
}

float grain(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uSize) / uRadius;
  float far = length(uv);

  // A halo that the voice brightens.
  float glow = exp(-max(far - 1.0, 0.0) * 2.4) * (0.05 + 0.22 * uLevel);
  vec4 color = vec4(mix(SKY, PEACH, 0.65 * uWarm) * glow, glow);

  if (far < BOUND) {
    float turnC = cos(uSpin);
    float turnS = sin(uSpin);
    mat2 spin = mat2(turnC, -turnS, turnS, turnC);

    // Find the surface point that sits over this pixel: guess a sphere, then
    // correct the guess with the real reach in that direction, twice.
    vec3 slope;
    vec3 dir;
    float rho = 1.0;
    for (int i = 0; i < 3; i++) {
      dir = normalize(vec3(uv, sqrt(max(rho * rho - far * far, 0.0)) + 0.001));
      dir.xz = spin * dir.xz;
      rho = reach(dir, slope);
    }

    // Signed distance to the silhouette in pixels gives a soft, exact edge.
    float cover = clamp((rho - far) * uRadius / 1.5 + 0.5, 0.0, 1.0);
    if (cover > 0.0) {
      // The normal leans away from wherever the surface is rising.
      vec3 n = normalize(rho * dir - (slope - dir * dot(dir, slope)));
      vec3 at = dir * rho;
      n.xz = n.xz * spin;
      float rim = pow(1.0 - clamp(n.z, 0.0, 1.0), 2.4);
      vec3 light = normalize(vec3(-0.5, 0.7, 0.55));

      // Colour is read a little way inside, so it floats under the skin.
      vec3 body = opal(at * 1.1 - n * 0.3);
      // Matte, like the opal: soft shading and a wide sheen, no hard highlight.
      body *= mix(0.8, 1.05, dot(n, light) * 0.5 + 0.5);
      body += pow(max(dot(n, normalize(light + vec3(0.0, 0.0, 1.0))), 0.0), 6.0) * 0.09;
      // The edge catches light like frosted glass. On a light page it deepens
      // instead, so the blob never fades into the background.
      body = mix(body, mix(body * 0.84, vec3(1.0), uDark), rim * mix(0.5, 0.62, uDark));

      color = vec4(body * cover, cover) + color * (1.0 - cover);
    }
  }

  // A grain of noise hides banding in the soft gradients.
  color.rgb += (grain(gl_FragCoord.xy) - 0.5) / 255.0 * color.a;
  gl_FragColor = color;
}
`;

function compile(gl: WebGLRenderingContext): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, source] of [
    [gl.VERTEX_SHADER, VERTEX],
    [gl.FRAGMENT_SHADER, FRAGMENT],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) ?? "Shader failed to compile");
    }
    gl.attachShader(program, shader);
  }
  gl.bindAttribLocation(program, 0, "corner");
  gl.linkProgram(program);
  gl.useProgram(program);
  return program;
}

/**
 * Max. It swells and warms with its own voice when it speaks, cools and settles
 * when it listens, and turns steadily while it works alone.
 */
export function Blob() {
  const { state } = useStore();
  const call = useCall();
  const canvas = useRef<HTMLCanvasElement>(null);

  const input = useRef({ call, state });
  input.current = { call, state };

  useEffect(() => {
    const el = canvas.current!;
    const gl = el.getContext("webgl", { antialias: false });
    if (!gl) return;
    const program = compile(gl);
    const places = new Map<string, WebGLUniformLocation | null>();
    const at = (name: string) => {
      if (!places.has(name)) places.set(name, gl.getUniformLocation(program, name));
      return places.get(name)!;
    };

    // One triangle that covers the canvas.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const bands = new Float32Array(3);
    let level = 0;
    let warm = 0.55;
    let scale = 0.85;
    let work = 0;
    let dark = 1;
    let time = 0;
    let flow = 0;
    let spin = 0;
    let last = performance.now();
    let frame = 0;
    let frames = 0;

    const draw = () => {
      frame = requestAnimationFrame(draw);
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      // Smoothing that behaves the same at any frame rate.
      const ease = (seconds: number) => 1 - Math.exp(-dt / seconds);

      const { call, state } = input.current;
      const live = call.status === "live";
      const connecting = call.status === "connecting";
      const narrating = state.narratingId !== null;
      const running = state.run === "running";
      const speaking = (live && call.speaking) || narrating;
      const listening = live && !call.speaking;

      // Speech lives in the lowest fifth of the spectrum; split it into log bands.
      const data = still ? SILENCE : live ? call.spectrum() : audio.spectrum();
      const usable = Math.max(3, Math.floor(data.length * 0.22));
      let sum = 0;
      for (let b = 0; b < 3; b += 1) {
        const from = Math.round(usable ** (b / 3));
        const to = Math.max(from + 1, Math.round(usable ** ((b + 1) / 3)));
        let total = 0;
        for (let i = from; i < to && i < data.length; i += 1) total += data[i];
        // Noise floor, gain, then a soft knee so shouting does not tear the shape.
        const lifted = Math.max(0, (data.length ? total / (to - from) / 255 : 0) - 0.06) * 2.4;
        // Listening is calmer than speaking: the shape follows the voice, at a distance.
        const target = (lifted / (lifted + 0.35)) * (listening ? 0.6 : 1);
        // Rise fast, fall slowly: speech stays readable instead of flickering.
        bands[b] += (target - bands[b]) * ease(target > bands[b] ? 0.03 : 0.22);
        sum += bands[b];
      }
      level += (sum / 3 - level) * ease(0.08);

      work += ((running || connecting ? 1 : 0) - work) * ease(0.4);
      warm += ((speaking ? 1 : listening ? 0.12 : connecting ? 0.3 : running ? 0.42 : 0.55) - warm) * ease(0.5);
      const size = connecting ? 0.72 : speaking ? 1 : listening ? 0.9 : running ? 0.92 : 0.85;
      scale += (size - scale) * ease(0.3);

      // Loudness quickens the drift a little; mostly it decides how far things move.
      if (!still) {
        time += dt * (0.55 + 0.9 * level + 0.35 * work);
        flow += dt * (0.6 + 1.8 * level + 0.4 * work);
        spin += dt * (0.06 + 0.5 * work);
      }

      // Follow the theme: the rim is lit on a dark page and deepened on a light one.
      if (frames++ % 30 === 0) {
        const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g)!.map(Number);
        dark = r + g + b < 384 ? 1 : 0;
      }

      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.round(el.clientWidth * ratio);
      const height = Math.round(el.clientHeight * ratio);
      if (el.width !== width || el.height !== height) {
        el.width = width;
        el.height = height;
        gl.viewport(0, 0, width, height);
      }

      gl.uniform2f(at("uSize"), width, height);
      gl.uniform1f(at("uRadius"), Math.min(height * 0.33, width * 0.3) * scale);
      gl.uniform1f(at("uTime"), time);
      gl.uniform1f(at("uFlow"), flow);
      gl.uniform1f(at("uSpin"), spin);
      gl.uniform1f(at("uLevel"), level);
      gl.uniform3fv(at("uBands"), bands);
      gl.uniform1f(at("uWarm"), warm);
      gl.uniform1f(at("uDark"), dark);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    draw();
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={canvas} className="blob" aria-hidden="true" />;
}
