// The bots' "minds": glossy 3D blobs, raymarched in WebGL.
// One shared WebGL context renders every mind on the page, then copies each
// frame into that mind's own canvas, so 3 or 30 minds cost one GPU context.
//
//   const m = new Mind("#ff7a3d", 300, seed);
//   container.append(m.el);
//   m.target = 0..1   → voice loudness (mouth)
//   m.thinking = true → nodes speed up and swirl, core pulses with light
//
// Falls back to a flat SVG blob where WebGL isn't available.

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const NODES = 5;

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime, uLevel, uThink, uCore, uZoom, uGlow;
uniform vec3 uColor;
uniform vec4 uNodes[${NODES}];

float smin(float a, float b, float k){
  float h = clamp(0.5 + 0.5*(b - a)/k, 0.0, 1.0);
  return mix(b, a, h) - k*h*(1.0 - h);
}
float map(vec3 p){
  float d = length(p) - uCore;
  for (int i = 0; i < ${NODES}; i++) {
    d = smin(d, length(p - uNodes[i].xyz) - uNodes[i].w, 0.42);
  }
  // living surface: a soft ripple that grows when talking or thinking
  float rip = sin(6.0*p.x + uTime*2.1) * sin(6.0*p.y - uTime*1.7) * sin(6.0*p.z + uTime*1.3);
  return d + rip * (0.012 + 0.03*uLevel + 0.015*uThink);
}
vec3 normalAt(vec3 p){
  const vec2 e = vec2(0.0015, -0.0015);
  return normalize(e.xyy*map(p + e.xyy) + e.yyx*map(p + e.yyx) + e.yxy*map(p + e.yxy) + e.xxx*map(p + e.xxx));
}
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*uRes) / (0.5*uRes.y);
  vec3 ro = vec3(0.0, 0.0, 3.4);
  vec3 rd = normalize(vec3(uv, -1.75 * uZoom));
  float t = 0.0, dmin = 9.0;
  bool hit = false;
  for (int i = 0; i < 56; i++) {
    float d = map(ro + rd*t);
    dmin = min(dmin, d);
    if (d < 0.0015) { hit = true; break; }
    t += d;
    if (t > 6.0) break;
  }
  vec3 col; float a;
  if (hit) {
    vec3 p = ro + rd*t;
    vec3 n = normalAt(p);
    vec3 l = normalize(vec3(-0.5, 0.8, 0.7));
    float diff = max(dot(n, l), 0.0);
    float spec = pow(max(dot(reflect(-l, n), -rd), 0.0), 40.0);
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 2.5);
    vec3 deep = uColor * 0.35;
    col = mix(deep, uColor, 0.35 + 0.65*diff);
    col += rim * mix(uColor, vec3(1.0), 0.45) * (0.55 + 0.6*uThink);
    col += spec * 0.9;
    // inner light that pulses while thinking
    float pulse = 0.5 + 0.5*sin(uTime*3.5);
    col += uColor * uThink * 0.25 * pulse;
    col = mix(col, vec3(1.0), 0.18*smoothstep(0.6, 1.0, dot(n, normalize(vec3(-0.4, 0.6, 1.0)))));
    a = 1.0;
  } else {
    // soft aura around the mind + anti-aliased silhouette edge
    float glow = exp(-dmin*9.0) * (0.28 + 0.35*uThink + 0.45*uLevel) * uGlow;
    float pw = 2.5 / uRes.y * t;
    float edge = 1.0 - smoothstep(0.0, pw, dmin);
    col = mix(uColor, mix(uColor, vec3(1.0), 0.35), edge);
    a = max(glow, edge);
  }
  gl_FragColor = vec4(col, a);
}`;

let R; // shared renderer for small minds
function renderer() {
  if (R === undefined) R = createRenderer(document.createElement("canvas"), true);
  return R;
}

/** Compile the mind shader onto a canvas. Returns null if WebGL isn't available. */
function createRenderer(canvas, shared) {
  try {
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: shared });
    if (!gl) return null;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = {};
    for (const n of ["uRes", "uTime", "uLevel", "uThink", "uCore", "uZoom", "uGlow", "uColor", "uNodes"]) u[n] = gl.getUniformLocation(prog, n);
    gl.clearColor(0, 0, 0, 0);
    return { canvas, gl, u };
  } catch (e) {
    console.warn("3D minds unavailable, using flat minds:", e.message);
    return null;
  }
}

/**
 * Render settings for slow machines (e.g. the Twitch broadcaster, which has no GPU):
 *   quality – 1 = full resolution; 0.4 renders at 40% and scales up (cost falls with the square)
 *   fps     – frame-rate cap for the 3D minds; 0 = as fast as the display
 */
export const mindSettings = { quality: 1, fps: 0 };

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const minds = new Set();
let loop = 0;
let frame = 0;
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const m = e.target.__mind;
    if (m) m.visible = e.isIntersecting;
  }
});

export class Mind {
  constructor(color, size = 220, seed = 1, opts = {}) {
    this.color = color;
    this.size = size;
    this.seed = seed;
    this.level = 0;
    this.target = 0;
    this.thinkLevel = 0;
    this.thinking = false;
    this.visible = true;
    this.rgb = hexToRgb(color);
    // each node orbits in its own tilted plane
    this.orbits = Array.from({ length: NODES }, (_, i) => {
      const a = seed * 1.7 + i * 2.39996;
      return {
        phase: a,
        speed: 0.22 + ((i * 7 + Math.floor(seed * 3)) % 5) * 0.06,
        tiltX: Math.sin(a * 1.3) * 1.1,
        tiltZ: Math.cos(a * 0.7) * 1.1,
        r: 0.9 + (i % 3) * 0.08,
      };
    });

    const quality = opts.quality ?? mindSettings.quality;
    const px = opts.px ?? Math.max(48, Math.min(Math.round(size * Math.min(devicePixelRatio || 1, 2) * quality), 720));
    this.zoom = opts.zoom ?? (size < 120 ? 1.18 : 1);
    this.glow = opts.glow ?? 1;
    const canvas = document.createElement("canvas");
    canvas.className = "mind-canvas";
    canvas.width = px;
    canvas.height = px;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    // big minds get their own GPU context (no copying); small ones share one
    const own = size >= 200 ? createRenderer(canvas, false) : null;
    const r = own ?? (size < 200 ? renderer() : renderer());
    if (r) {
      this.el = canvas;
      this.own = own;
      if (!own) this.ctx = canvas.getContext("2d");
      this.mode = "3d";
    } else {
      this.el = flatMind(color, size, seed);
      this.mode = "flat";
    }
    this.el.setAttribute("aria-hidden", "true");
    this.el.__mind = this;
    this.draw(opts.t ?? performance.now());
    if (opts.still) return; // a single frame, e.g. for avatar images
    seen.observe(this.el);
    minds.add(this);
    if (!loop && !reduceMotion) loop = requestAnimationFrame(tick);
  }

  /** Brief "thinking" burst, e.g. when a new decision lands. */
  pulseThink(ms = 2500) {
    this.thinking = true;
    clearTimeout(this._tt);
    this._tt = setTimeout(() => (this.thinking = this.stickyThinking ?? false), ms);
  }

  setThinking(on) {
    this.stickyThinking = !!on;
    this.thinking = !!on;
  }

  /** Advance the mind's own clock. Speed changes ease in, so motion never jumps. */
  advance(t) {
    const dt = Math.min(50, Math.max(0, t - (this.lastT ?? t)));
    this.lastT = t;
    // calm: 1x, thinking: up to 1.9x, talking adds a little; never faster than ~2.1x
    const want = Math.min(2.1, 1 + this.thinkLevel * 0.9 + this.level * 0.25);
    this.speedF = (this.speedF ?? 1) + (want - (this.speedF ?? 1)) * Math.min(1, dt / 900);
    this.clock = (this.clock ?? 0) + dt * this.speedF;
  }

  nodePositions(t) {
    const L = this.level;
    const T = this.thinkLevel;
    const c = this.clock ?? t;
    const spin = c * 0.00025;
    return this.orbits.map((o, i) => {
      const ang = o.phase + c * 0.001 * o.speed;
      const breathe = Math.sin(t * 0.0011 * (1 + i * 0.17) + this.seed + i) * 0.08;
      const rad = o.r + breathe + L * 0.26 + T * 0.08 * Math.sin(t * 0.0025 + i);
      let x = Math.cos(ang) * rad;
      let y = 0;
      let z = Math.sin(ang) * rad;
      // tilt orbit plane
      let cy = Math.cos(o.tiltX), sy = Math.sin(o.tiltX);
      [y, z] = [y * cy - z * sy, y * sy + z * cy];
      cy = Math.cos(o.tiltZ);
      sy = Math.sin(o.tiltZ);
      [x, y] = [x * cy - y * sy, x * sy + y * cy];
      // slow global spin around Y
      const cs = Math.cos(spin), ss = Math.sin(spin);
      [x, z] = [x * cs + z * ss, -x * ss + z * cs];
      return [x, y, z, 0.27 + L * 0.07 + Math.sin(t * 0.002 + i) * 0.015];
    });
  }

  draw(t) {
    // smoothed so voice peaks swell the mind instead of jolting it
    this.level += (this.target - this.level) * 0.1;
    this.thinkLevel += ((this.thinking ? 1 : 0) - this.thinkLevel) * 0.03;
    this.advance(t);
    if (this.mode === "flat") return drawFlat(this, t);
    const r = this.own ?? renderer();
    if (!r) return;
    const { gl, u, canvas } = r;
    const w = this.el.width;
    if (!this.own && (canvas.width < w || canvas.height < w)) {
      canvas.width = Math.max(canvas.width, w);
      canvas.height = Math.max(canvas.height, w);
    }
    gl.viewport(0, 0, w, w);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(u.uRes, w, w);
    gl.uniform1f(u.uTime, t / 1000 + this.seed * 10);
    gl.uniform1f(u.uLevel, this.level);
    gl.uniform1f(u.uThink, this.thinkLevel);
    gl.uniform1f(u.uZoom, this.zoom);
    gl.uniform1f(u.uGlow, this.glow);
    gl.uniform1f(u.uCore, 0.62 + this.level * 0.14 + this.thinkLevel * 0.03 * Math.sin(t * 0.004) + Math.sin(t * 0.0012 + this.seed) * 0.02);
    gl.uniform3f(u.uColor, ...this.rgb);
    gl.uniform4fv(u.uNodes, new Float32Array(this.nodePositions(t).flat()));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (this.ctx) {
      this.ctx.clearRect(0, 0, w, w);
      this.ctx.drawImage(canvas, 0, canvas.height - w, w, w, 0, 0, w, w);
    }
  }
}

/**
 * A still image of a mind (PNG data URL), so small avatars in lists and chat show
 * each bot's real blob instead of a generic dot. Returns null without WebGL.
 */
const snapshots = new Map();
export function mindSnapshot(color, seed, px = 160) {
  const key = `${color}|${seed}|${px}`;
  if (snapshots.has(key)) return snapshots.get(key);
  let url = null;
  try {
    const m = new Mind(color, 80, seed, { px, still: true, zoom: 1.16, glow: 0.35, t: 4000 });
    if (m.mode === "3d") url = m.el.toDataURL("image/png");
  } catch {}
  snapshots.set(key, url);
  return url;
}

let lastTick = 0;
function tick(t) {
  if (mindSettings.fps > 0 && t - lastTick < 1000 / mindSettings.fps - 1) {
    loop = requestAnimationFrame(tick);
    return;
  }
  lastTick = t;
  frame++;
  for (const m of minds) {
    if (!m.el.isConnected) {
      minds.delete(m);
      seen.unobserve(m.el);
      continue;
    }
    if (!m.visible) continue;
    if (m.size < 120 && frame % 2) continue; // small minds: 30 fps is plenty
    m.draw(t);
  }
  loop = minds.size ? requestAnimationFrame(tick) : 0;
}

// ---------------------------------------------------------------- flat fallback

const SVGNS = "http://www.w3.org/2000/svg";
function flatMind(color, size, seed) {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 200 200");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("class", "mind-svg");
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  svg.innerHTML = `<defs><radialGradient id="${id}" cx="40%" cy="35%" r="75%"><stop offset="0%" stop-color="#fff"/><stop offset="45%" stop-color="${color}"/><stop offset="100%" stop-color="${color}" stop-opacity=".85"/></radialGradient></defs>
    <circle class="halo" cx="100" cy="100" r="70" fill="${color}" opacity=".18"/><g filter="url(#goo)" fill="url(#${id})"><circle cx="100" cy="100" r="32"/>${'<circle r="12"/>'.repeat(NODES)}</g>`;
  return svg;
}
function drawFlat(m, t) {
  const circles = m.el.querySelectorAll("g circle");
  const halo = m.el.querySelector(".halo");
  const L = m.level, T = m.thinkLevel;
  circles[0].setAttribute("r", (30 + L * 12 + Math.sin(t * 0.0012 + m.seed) * 2).toFixed(1));
  halo.setAttribute("r", (62 + L * 26 + T * 8).toFixed(1));
  m.nodePositions(t).forEach(([x, y, z, rad], i) => {
    const s = 1 + z * 0.15; // fake depth
    const c = circles[i + 1];
    c.setAttribute("cx", (100 + x * 44).toFixed(1));
    c.setAttribute("cy", (100 - y * 44).toFixed(1));
    c.setAttribute("r", (rad * 46 * s).toFixed(1));
  });
}
