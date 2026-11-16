// One full-stage pass: background -> screen shadow -> screen (with motion blur) -> cursor ->
// click effect. Blending happens in "blur-linear" space: gamma 2.0, premultiplied alpha
// (render.md §0). All positions are in stage units (stage height = 1080).

struct Params {
  stageSize: vec2f,          // stage units
  pxPerUnit: f32,            // device px per stage unit
  time: f32,
  screenNow: vec4f,          // x, y, w, h
  screenBefore: vec4f,
  screenRadius: f32,
  blurTaps: f32,             // motion blur samples (1 = static)
  screenOpacity: f32,
  hasScreen: f32,
  shadowColor: vec4f,        // rgb, alpha (intensity)
  shadowOffset: vec2f,
  shadowBlur: f32,
  shadowDirectional: f32,
  lightPos: vec2f,
  lightRadius: f32,
  shadowFalloff: f32,
  bgType: f32,               // 0 color, 1 gradient, 2 image
  bgStopCount: f32,
  bgBlur: f32,               // stage units
  bgScale: f32,
  bgOrigin: vec2f,
  bgStart: vec2f,
  bgEnd: vec2f,
  bgImageSize: vec2f,
  bgStops: array<vec4f, 8>,  // rgb (linear sRGB) + position
  cursorNow: vec4f,          // x, y, w, h of the image rect
  cursorBefore: vec4f,
  cursorPivotNow: vec2f,
  cursorPivotBefore: vec2f,
  cursorAngleNow: f32,
  cursorAngleBefore: f32,
  cursorOpacity: f32,
  cursorFadeBlur: f32,       // stage units
  clickCount: f32,
  clickStyle: f32,           // 0 none, 1 circle
  videoWidthUnits: f32,      // screen rect width, for effect sizes
  _pad0: f32,
  clicks: array<vec4f, 3>,   // x, y (stage units), age01, unused
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var screenTex: texture_2d<f32>;
@group(0) @binding(3) var cursorTex: texture_2d<f32>;
@group(0) @binding(4) var bgTex: texture_2d<f32>;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) stage: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  // Full-screen triangle.
  var xy = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VsOut;
  o.pos = vec4f(xy[i], 0.0, 1.0);
  let uv = vec2f((xy[i].x + 1.0) * 0.5, 1.0 - (xy[i].y + 1.0) * 0.5);
  o.stage = uv * P.stageSize;
  return o;
}

// ---- Colour helpers -------------------------------------------------------------------------

fn toBlurLinear(c: vec4f) -> vec4f { // straight sRGB-ish -> gamma 2 premultiplied
  return vec4f(c.rgb * c.rgb * c.a, c.a);
}

fn fromBlurLinear(c: vec4f) -> vec4f { // premultiplied gamma 2 -> premultiplied display
  if (c.a <= 0.00001) { return vec4f(0.0); }
  let straight = c.rgb / c.a;
  return vec4f(sqrt(max(straight, vec3f(0.0))) * c.a, c.a);
}

fn over(fg: vec4f, bg: vec4f) -> vec4f { return fg + bg * (1.0 - fg.a); }

fn linearToOklab(c: vec3f) -> vec3f {
  let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  let l_ = pow(max(l, 0.0), 1.0 / 3.0);
  let m_ = pow(max(m, 0.0), 1.0 / 3.0);
  let s_ = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3f(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_);
}

fn oklabToLinear(c: vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return vec3f(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}

fn linearToSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

// OKLCH mix component-wise (no hue wrap), matching the reference gradient.
fn mixOklch(a: vec3f, b: vec3f, t: f32) -> vec3f {
  let la = linearToOklab(a);
  let lb = linearToOklab(b);
  let ca = vec3f(la.x, length(la.yz), atan2(la.z, la.y));
  let cb = vec3f(lb.x, length(lb.yz), atan2(lb.z, lb.y));
  let m = mix(ca, cb, t);
  return oklabToLinear(vec3f(m.x, m.y * cos(m.z), m.y * sin(m.z)));
}

fn bayer8(p: vec2f) -> f32 {
  let x = u32(p.x) & 7u;
  let y = u32(p.y) & 7u;
  // Standard 8x8 ordered dither, built from the 2x2 recursion.
  var v = 0u;
  var xx = x;
  var yy = y;
  for (var i = 0u; i < 3u; i++) {
    v = (v << 2u) | (((xx & 1u) ^ (yy & 1u)) | ((yy & 1u) << 1u));
    xx = xx >> 1u;
    yy = yy >> 1u;
  }
  return (f32(v) + 0.5) / 64.0;
}

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}

// ---- Shapes ----------------------------------------------------------------------------------

fn sdRoundRect(p: vec2f, rect: vec4f, radius: f32) -> f32 {
  let half = rect.zw * 0.5;
  let c = rect.xy + half;
  let r = min(radius, min(half.x, half.y));
  let q = abs(p - c) - half + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

fn aaUnits() -> f32 { return 1.5 / P.pxPerUnit; }

// ---- Background -----------------------------------------------------------------------------

fn gradientAt(p01: vec2f) -> vec3f {
  let dir = P.bgEnd - P.bgStart;
  let t = clamp(dot(p01 - P.bgStart, dir) / max(dot(dir, dir), 1e-6), 0.0, 1.0);
  let n = i32(P.bgStopCount);
  var col = P.bgStops[0].rgb;
  for (var i = 1; i < 8; i++) {
    if (i >= n) { break; }
    let a = P.bgStops[i - 1];
    let b = P.bgStops[i];
    if (t >= a.w) {
      let f = clamp((t - a.w) / max(b.w - a.w, 1e-6), 0.0, 1.0);
      col = mixOklch(a.rgb, b.rgb, f);
    }
  }
  return linearToSrgb(col);
}

fn sampleBackgroundImage(p: vec2f, blurUnits: f32) -> vec3f {
  // Cover fit, then the zoom-dependent scale about the zoom focus.
  let s = max(P.stageSize.x / P.bgImageSize.x, P.stageSize.y / P.bgImageSize.y);
  let size = P.bgImageSize * s;
  let off = (P.stageSize - size) * 0.5;
  let origin = P.bgOrigin * P.stageSize;
  let q = origin + (p - origin) / P.bgScale;
  let uv = (q - off) / size;
  if (blurUnits < 0.5) {
    return textureSampleLevel(bgTex, linearSampler, uv, 0.0).rgb;
  }
  // 12-tap jittered ring blur.
  let j = hash(p) * 6.2831853;
  var acc = vec3f(0.0);
  for (var i = 0; i < 12; i++) {
    let a = j + f32(i) * 0.5235988;
    let r = blurUnits * (0.35 + 0.65 * fract(f32(i) * 0.618 + 0.3));
    let o = vec2f(cos(a), sin(a)) * r / size;
    acc += textureSampleLevel(bgTex, linearSampler, uv + o, 0.0).rgb;
  }
  return acc / 12.0;
}

fn background(p: vec2f) -> vec4f {
  var rgb = P.bgStops[0].rgb;
  if (P.bgType > 1.5) {
    rgb = sampleBackgroundImage(p, P.bgBlur);
  } else if (P.bgType > 0.5) {
    let origin = P.bgOrigin * P.stageSize;
    let q = origin + (p - origin) / P.bgScale;
    rgb = gradientAt(q / P.stageSize);
  } else {
    rgb = linearToSrgb(P.bgStops[0].rgb);
  }
  return toBlurLinear(vec4f(rgb, 1.0));
}

// ---- Shadow (directional sphere trace toward the light, render.md §3.2) ---------------------

fn screenShadowMask(p: vec2f) -> f32 {
  let rect = P.screenNow;
  if (P.shadowDirectional > 0.5) {
    let d0 = sdRoundRect(p, rect, P.screenRadius);
    let proximity = 1.0 - clamp(d0 / P.shadowFalloff, 0.0, 1.0);
    if (proximity <= 0.001) { return 0.0; }
    let toLight = P.lightPos - p;
    let dist = length(toLight);
    let dir = toLight / max(dist, 1e-4);
    let k = dist / max(P.lightRadius, 1.0);
    var vis = 1.0;
    var t = 2.0;
    for (var i = 0; i < 12; i++) {
      if (t >= dist || vis < -0.5) { break; }
      let h = sdRoundRect(p + dir * t, rect, P.screenRadius);
      vis = min(vis, k * h / t);
      t += max(h, 3.0);
    }
    return (1.0 - clamp(vis, 0.0, 1.0)) * proximity * proximity;
  }
  let aa = aaUnits();
  let d = sdRoundRect(p - P.shadowOffset, rect, P.screenRadius);
  return smoothstep(P.shadowBlur + aa, -0.5 * P.shadowBlur - aa, d);
}

// ---- Screen with motion blur ----------------------------------------------------------------

fn screenSample(p: vec2f, rect: vec4f) -> vec4f {
  let aa = aaUnits();
  let cov = smoothstep(aa, -aa, sdRoundRect(p, rect, P.screenRadius * rect.z / max(P.screenNow.z, 1e-4)));
  if (cov <= 0.0) { return vec4f(0.0); }
  let uv = clamp((p - rect.xy) / rect.zw, vec2f(0.0), vec2f(1.0));
  let c = textureSampleLevel(screenTex, linearSampler, uv, 0.0);
  return toBlurLinear(vec4f(c.rgb, 1.0)) * cov;
}

fn screenLayer(p: vec2f, frag: vec2f) -> vec4f {
  if (P.hasScreen < 0.5) { return vec4f(0.0); }
  let n = max(1.0, P.blurTaps);
  if (n <= 1.0) { return screenSample(p, P.screenNow) * P.screenOpacity; }
  let jitter = bayer8(frag);
  var acc = vec4f(0.0);
  for (var i = 0.0; i < 32.0; i += 1.0) {
    if (i >= n) { break; }
    let t = (i + jitter) / n;
    acc += screenSample(p, mix(P.screenBefore, P.screenNow, t));
  }
  return acc / n * P.screenOpacity;
}

// ---- Cursor ----------------------------------------------------------------------------------

fn rotateAbout(p: vec2f, pivot: vec2f, angle: f32) -> vec2f {
  let c = cos(-angle);
  let s = sin(-angle);
  let d = p - pivot;
  return pivot + vec2f(d.x * c - d.y * s, d.x * s + d.y * c);
}

fn cursorSampleAt(p: vec2f, rect: vec4f, pivot: vec2f, angle: f32) -> vec4f {
  if (rect.z <= 0.0) { return vec4f(0.0); }
  let q = rotateAbout(p, pivot, angle);
  let uv = (q - rect.xy) / rect.zw;
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return vec4f(0.0); }
  var c = vec4f(0.0);
  if (P.cursorFadeBlur > 0.25) {
    let r = P.cursorFadeBlur / rect.zw;
    for (var i = 0; i < 8; i++) {
      let a = f32(i) * 0.7853982;
      c += textureSampleLevel(cursorTex, linearSampler, uv + vec2f(cos(a), sin(a)) * r * 0.7, 0.0);
    }
    c = c / 8.0;
  } else {
    c = textureSampleLevel(cursorTex, linearSampler, uv, 0.0);
  }
  // Texture is straight alpha.
  return vec4f(c.rgb * c.rgb * c.a, c.a);
}

fn cursorLayer(p: vec2f, frag: vec2f) -> vec4f {
  if (P.cursorOpacity <= 0.001) { return vec4f(0.0); }
  let n = max(1.0, P.blurTaps);
  if (n <= 1.0) { return cursorSampleAt(p, P.cursorNow, P.cursorPivotNow, P.cursorAngleNow) * P.cursorOpacity; }
  let jitter = bayer8(frag + vec2f(3.0, 5.0));
  var acc = vec4f(0.0);
  for (var i = 0.0; i < 32.0; i += 1.0) {
    if (i >= n) { break; }
    let t = (i + jitter) / n;
    acc += cursorSampleAt(p, mix(P.cursorBefore, P.cursorNow, t), mix(P.cursorPivotBefore, P.cursorPivotNow, t), mix(P.cursorAngleBefore, P.cursorAngleNow, t));
  }
  return acc / n * P.cursorOpacity;
}

// ---- Click effect (circle, cursor.md §4.4) ---------------------------------------------------

fn clickLayer(p: vec2f) -> vec4f {
  if (P.clickStyle < 0.5) { return vec4f(0.0); }
  let w = P.videoWidthUnits;
  let aa = aaUnits();
  var out = vec4f(0.0);
  for (var i = 0; i < 3; i++) {
    if (f32(i) >= P.clickCount) { break; }
    let c = P.clicks[i];
    let prog = c.z;
    let r = w * (0.002 + 0.028 * (1.0 - pow(1.0 - prog, 3.0)));
    let fade = smoothstep(0.0, 0.15, prog) * (1.0 - smoothstep(0.15, 0.9, prog));
    let dist = length(p - c.xy);
    let fill = 1.0 - smoothstep(r - aa, r + aa, dist);
    let rim = 1.0 - smoothstep(0.0007 * w, 0.0007 * w + aa, abs(dist - r));
    let rimA = rim * 0.5;
    let alpha = (rimA + fill * (1.0 - rimA)) * 0.6 * fade;
    let gray = 0.7569 * fill * (1.0 - rimA) * 0.6 * fade;
    out = over(vec4f(vec3f(gray), alpha), out);
  }
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let p = in.stage;
  var color = background(p);
  // Shadow goes only where the screen does not cover.
  let shadow = screenShadowMask(p) * P.shadowColor.a * P.hasScreen;
  color = over(vec4f(toBlurLinear(vec4f(P.shadowColor.rgb, 1.0)).rgb * shadow, shadow), color);
  let scr = screenLayer(p, in.pos.xy);
  color = over(scr, color);
  color = over(clickLayer(p), color);
  color = over(cursorLayer(p, in.pos.xy), color);
  var outc = fromBlurLinear(color);
  outc = vec4f(outc.rgb + (bayer8(in.pos.xy) - 0.5) / 255.0 * outc.a, outc.a);
  return outc;
}
