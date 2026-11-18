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
  bgType: f32,               // 0 color, 1 gradient, 2 image, 3 mesh
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
  clickStyle: f32,           // 0 none, 1 circle, 2 ripple
  videoWidthUnits: f32,      // screen rect width, for effect sizes
  ripplePull01: f32,         // ripple calm radius, fraction of the video width
  clicks: array<vec4f, 3>,   // x, y (stage units), age01, unused
  viewCenter: vec2f,         // draw the stage magnified viewScale x about this point
  viewScale: f32,            // (1 = normal; the loupe pass reads a magnified copy)
  drawMode: f32,             // 0 everything, 1 all but the webcam, 2 only the webcam (and its shadow)
  cameraNow: vec4f,          // webcam bubble rect
  cameraBefore: vec4f,
  cameraRadius: f32,         // at cameraNow's size
  cameraOpacity: f32,
  cameraMirror: f32,
  hasCamera: f32,
  cameraSize: vec2f,         // webcam frame size in pixels
  _pad2: vec2f,
  screenCornerLut: array<vec4f, 4>,  // smoothed-corner ray table (core/geometry/squircle.ts)
  cameraCornerLut: array<vec4f, 4>,
  cameraGrain: f32,          // film grain intensity 0..1
  grainSeed: f32,
  cameraLutIntensity: f32,   // 0 = no LUT
  _pad3: f32,
  cameraFocus: vec2f,        // point of the webcam frame (0..1) kept centred when cropping
  _pad4: vec2f,
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var screenTex: texture_2d<f32>;
@group(0) @binding(3) var cursorTex: texture_2d<f32>;
@group(0) @binding(4) var bgTex: texture_2d<f32>;
@group(0) @binding(5) var cameraTex: texture_2d<f32>;
@group(0) @binding(6) var cameraLut: texture_3d<f32>;

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

fn cornerLut(which: i32, i: i32) -> f32 {
  let v = select(P.screenCornerLut[i / 4], P.cameraCornerLut[i / 4], which == 1);
  return v[i % 4];
}

// Figma-smoothed rounded rect (render.md §4.1): a rounded-rect SDF with corner extent
// p = min(short/2, 2·min(r, short/2)) whose radius is scaled per angle by the ray table.
fn sdSquircle(p: vec2f, rect: vec4f, radius: f32, which: i32) -> f32 {
  let half = rect.zw * 0.5;
  let m = min(half.x, half.y);
  let ext = min(m, 2.0 * min(radius, m));
  let d = abs(p - (rect.xy + half)) + vec2f(ext) - half;
  var ratio = 1.0;
  if (d.x > 0.0 && d.y > 0.0) {
    let angle = atan2(d.y, d.x);
    let folded = 0.78539816 - abs(angle - 0.78539816);
    let idx = folded * 19.098593;
    let i0 = i32(clamp(idx, 0.0, 15.0));
    let i1 = min(i0 + 1, 15);
    ratio = mix(cornerLut(which, i0), cornerLut(which, i1), fract(idx));
  }
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0) - ext * ratio;
}

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

// Mesh gradient: four corner colours blended in OKLab over a softly warped domain, for a
// wallpaper-like background.
fn meshAt(p01: vec2f) -> vec3f {
  let w = vec2f(
    p01.x + 0.08 * sin(p01.y * 5.0 + 1.3) + 0.04 * sin(p01.y * 11.0 + p01.x * 3.0),
    p01.y + 0.08 * sin(p01.x * 4.0 + 0.7) + 0.04 * sin(p01.x * 9.0 - p01.y * 2.0));
  let u = clamp(w, vec2f(0.0), vec2f(1.0));
  let s = u * u * (3.0 - 2.0 * u);
  let a = linearToOklab(P.bgStops[0].rgb);
  let b = linearToOklab(P.bgStops[1].rgb);
  let c = linearToOklab(P.bgStops[2].rgb);
  let d = linearToOklab(P.bgStops[3].rgb);
  let top = mix(a, b, s.x);
  let bottom = mix(c, d, s.x);
  return linearToSrgb(max(oklabToLinear(mix(top, bottom, s.y)), vec3f(0.0)));
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
  if (P.bgType > 2.5) {
    let origin = P.bgOrigin * P.stageSize;
    let q = origin + (p - origin) / P.bgScale;
    rgb = meshAt(q / P.stageSize);
  } else if (P.bgType > 1.5) {
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

fn rectShadowMask(p: vec2f, rect: vec4f, radius: f32) -> f32 {
  if (P.shadowDirectional > 0.5) {
    let d0 = sdRoundRect(p, rect, radius);
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
      let h = sdRoundRect(p + dir * t, rect, radius);
      vis = min(vis, k * h / t);
      t += max(h, 3.0);
    }
    return (1.0 - clamp(vis, 0.0, 1.0)) * proximity * proximity;
  }
  let aa = aaUnits();
  let d = sdRoundRect(p - P.shadowOffset, rect, radius);
  return smoothstep(P.shadowBlur + aa, -0.5 * P.shadowBlur - aa, d);
}

fn shadowOver(color: vec4f, mask: f32) -> vec4f {
  let a = mask * P.shadowColor.a;
  return over(vec4f(toBlurLinear(vec4f(P.shadowColor.rgb, 1.0)).rgb * a, a), color);
}

// ---- Webcam bubble (cover-fit, rounded, optional mirror) --------------------------------------

fn cameraSample(p: vec2f, rect: vec4f) -> vec4f {
  let aa = aaUnits();
  let cov = smoothstep(aa, -aa, sdSquircle(p, rect, P.cameraRadius * rect.z / max(P.cameraNow.z, 1e-4), 1));
  if (cov <= 0.0) { return vec4f(0.0); }
  var uv = clamp((p - rect.xy) / rect.zw, vec2f(0.0), vec2f(1.0));
  let rectAspect = rect.z / max(rect.w, 1e-4);
  let texAspect = P.cameraSize.x / max(P.cameraSize.y, 1.0);
  // Mirror within the bubble first, so the crop still frames the same part of the video.
  if (P.cameraMirror > 0.5) { uv.x = 1.0 - uv.x; }
  // Cover-fit: crop the frame around the focus point (the face, with face tracking), staying
  // inside the frame.
  if (texAspect > rectAspect) {
    let span = rectAspect / texAspect;
    let start = clamp(P.cameraFocus.x - span * 0.5, 0.0, 1.0 - span);
    uv.x = start + uv.x * span;
  } else {
    let span = texAspect / rectAspect;
    let start = clamp(P.cameraFocus.y - span * 0.5, 0.0, 1.0 - span);
    uv.y = start + uv.y * span;
  }
  let c = textureSampleLevel(cameraTex, linearSampler, uv, 0.0);
  return toBlurLinear(vec4f(c.rgb, 1.0)) * cov;
}

// ---- Webcam grading: 3D LUT and film grain (reference applyFilmGrain, B39:10117-10260) -----

fn gradeCamera(rgb: vec3f) -> vec3f {
  if (P.cameraLutIntensity <= 0.0) { return rgb; }
  let n = f32(textureDimensions(cameraLut).x);
  let uvw = clamp(rgb, vec3f(0.0), vec3f(1.0)) * ((n - 1.0) / n) + 0.5 / n;
  let graded = textureSampleLevel(cameraLut, linearSampler, uvw, 0.0).rgb;
  return mix(rgb, graded, P.cameraLutIntensity);
}

fn hashGrainCell(x: f32, y: f32, seed: f32) -> vec3f {
  var h = fract(vec3f(x, y, seed) * vec3f(0.1031, 0.103, 0.0973));
  h = h + dot(h, h.yxz + 33.33);
  return fract((h.xxy + h.yxx) * h.zyx) * 2.0 - 1.0;
}

fn grainLattice(c: vec2f, seed: f32) -> vec3f {
  let cell = floor(c);
  let f = c - cell;
  let e = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let top = mix(hashGrainCell(cell.x, cell.y, seed), hashGrainCell(cell.x + 1.0, cell.y, seed), e.x);
  let bottom = mix(hashGrainCell(cell.x, cell.y + 1.0, seed), hashGrainCell(cell.x + 1.0, cell.y + 1.0, seed), e.x);
  return mix(top, bottom, e.y);
}

fn filmGrain(straight: vec3f, frag: vec2f, intensity: f32) -> vec3f {
  let fine = frag / 1.1; // FILM_GRAIN_CELL_DEVICE_PIXELS
  let noise = (grainLattice(fine, P.grainSeed) * 0.65 + grainLattice(fine / 1.7 + 511.5, P.grainSeed + 1024.0) * 0.35) * 3.0;
  let grain = mix(vec3f(noise.y), noise, 0.35);
  let luma = clamp(dot(straight, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  let response = smoothstep(0.0, 0.1, luma) * (1.0 - 0.65 * smoothstep(0.55, 1.0, luma));
  return clamp(straight + grain * intensity * 0.09 * response, vec3f(0.0), vec3f(1.0));
}

// Grade and grain a premultiplied blur-linear webcam colour in display space.
fn finishCamera(c: vec4f, frag: vec2f) -> vec4f {
  if (c.a <= 0.001 || (P.cameraGrain < 0.001 && P.cameraLutIntensity <= 0.0)) { return c; }
  var straight = sqrt(max(c.rgb / c.a, vec3f(0.0)));
  straight = gradeCamera(straight);
  // Grain fades as the bubble moves (1/sqrt of its trail in device px).
  let trail = length((P.cameraNow.xy - P.cameraBefore.xy)) * P.pxPerUnit;
  let g = P.cameraGrain / sqrt(max(trail, 1.0));
  if (g >= 0.001) { straight = filmGrain(straight, frag, g); }
  return vec4f(straight * straight * c.a, c.a);
}

fn cameraLayer(p: vec2f, frag: vec2f) -> vec4f {
  let n = max(1.0, P.blurTaps);
  if (n <= 1.0 || all(P.cameraNow == P.cameraBefore)) { return cameraSample(p, P.cameraNow) * P.cameraOpacity; }
  let jitter = bayer8(frag + vec2f(6.0, 1.0));
  var acc = vec4f(0.0);
  for (var i = 0.0; i < 32.0; i += 1.0) {
    if (i >= n) { break; }
    acc += cameraSample(p, mix(P.cameraBefore, P.cameraNow, (i + jitter) / n));
  }
  return acc / n * P.cameraOpacity;
}

// ---- Screen with motion blur ----------------------------------------------------------------

// Ripple click effect (cursor.md §4.4): a ring travelling out from each click pulls the screen
// image, with a small colour split. Returns (offset.xy, chroma.xy) in stage units.
fn rippleWarp(p: vec2f) -> vec4f {
  if (P.clickStyle < 1.5) { return vec4f(0.0); }
  let w = P.videoWidthUnits;
  var acc = vec4f(0.0);
  for (var i = 0; i < 3; i++) {
    if (f32(i) >= P.clickCount) { break; }
    let c = P.clicks[i];
    let tau = c.z;
    let k = P.ripplePull01 * w;
    let radius = k + tau * w * 0.2;
    let bounce = exp(-3.0 * tau) * sin(9.4 * tau);
    let band = 0.05 * w;
    let d = p - c.xy;
    let dist = length(d);
    let r = (dist - radius) / band;
    if (abs(r) > 3.0 || dist < 1e-4) { continue; }
    let ring = exp(-4.0 * r * r);
    let gate = select(1.0, smoothstep(0.35 * k, k, dist), k > 0.5 / P.pxPerUnit);
    let dir = d / dist;
    acc += vec4f(dir * bounce * ring * w * 0.015 * gate, dir * abs(bounce) * ring * (1.0 - ring) * 4.0 * w * 0.004 * gate);
  }
  return acc;
}

fn screenSample(p: vec2f, rect: vec4f) -> vec4f {
  let aa = aaUnits();
  let cov = smoothstep(aa, -aa, sdSquircle(p, rect, P.screenRadius * rect.z / max(P.screenNow.z, 1e-4), 0));
  if (cov <= 0.0) { return vec4f(0.0); }
  let warp = rippleWarp(p);
  let q = p - warp.xy;
  let uv = clamp((q - rect.xy) / rect.zw, vec2f(0.0), vec2f(1.0));
  var c = textureSampleLevel(screenTex, linearSampler, uv, 0.0);
  if (any(warp.zw != vec2f(0.0))) {
    let off = warp.zw / rect.zw;
    c.r = textureSampleLevel(screenTex, linearSampler, clamp(uv - off, vec2f(0.0), vec2f(1.0)), 0.0).r;
    c.b = textureSampleLevel(screenTex, linearSampler, clamp(uv + off, vec2f(0.0), vec2f(1.0)), 0.0).b;
  }
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
  if (P.clickStyle < 0.5 || P.clickStyle > 1.5) { return vec4f(0.0); }
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
  let p = P.viewCenter + (in.stage - P.viewCenter) / P.viewScale;
  var color = vec4f(0.0);
  if (P.drawMode < 1.5) {
    color = background(p);
    // Shadow goes only where the screen does not cover.
    color = shadowOver(color, rectShadowMask(p, P.screenNow, P.screenRadius) * P.hasScreen);
    color = over(screenLayer(p, in.pos.xy), color);
    color = over(clickLayer(p), color);
    color = over(cursorLayer(p, in.pos.xy), color);
  }
  if (P.drawMode != 1.0 && P.hasCamera > 0.5 && P.cameraOpacity > 0.001) {
    color = shadowOver(color, rectShadowMask(p, P.cameraNow, P.cameraRadius) * P.cameraOpacity);
    color = over(finishCamera(cameraLayer(p, in.pos.xy), in.pos.xy), color);
  }
  var outc = fromBlurLinear(color);
  outc = vec4f(outc.rgb + (bayer8(in.pos.xy) - 0.5) / 255.0 * outc.a, outc.a);
  return outc;
}
