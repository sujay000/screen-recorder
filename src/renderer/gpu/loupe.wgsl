// Glass loupe pass (spec: render.md §5). Draws the finished frame ("plain scene") with a glass
// magnifier over it: a magnified view of the scene inside the lens, refracted and colour-split at
// the rim, lit by the same light as the screen shadow, with a soft shadow and light pool outside.
//
// Lens math runs in screen-video pixels, like the reference. Colours are premultiplied display
// values, as stored in the scene textures.

struct LoupeParams {
  stageSize: vec2f,
  pxPerUnit: f32,          // device px per stage unit
  fringeReads: f32,        // colour-fringe sample budget
  screen: vec4f,           // where the screen video sits on the stage
  videoSize: vec2f,
  center: vec2f,           // video px
  radius: f32,
  bevel: f32,
  zoom: f32,
  chromaticAberration: f32,
  lightDirection: vec2f,
  shineExponent: f32,
  lightTilt: f32,
  shadowAlpha: f32,
  shadowSize: f32,
  presence: f32,
  _pad0: f32,
  magnifyCenter: vec2f,    // stage units; magTex is the scene magnified `zoom`x about this point
  _pad1: vec2f,
};

@group(0) @binding(0) var<uniform> L: LoupeParams;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var plainTex: texture_2d<f32>;
@group(0) @binding(3) var magTex: texture_2d<f32>;

// Look of the glass (the reference's fixed loupe settings).
const INNER_SHINE_SIZE = 1.0;
const INNER_SHINE_STRENGTH = 0.25;
const INNER_RAINBOW = 0.5;
const INNER_RAINBOW_SPAN_START = 0.0;
const OUTER_SHINE_SIZE = 0.5;
const OUTER_SHINE_STRENGTH = 0.3;
const OUTER_RAINBOW = 0.5;
const OUTER_RAINBOW_SPAN_START = 0.0;
const POOL_WHITE_LEVEL = 0.5;
const SHINE_POLISH = 0.9;
const SHINE_ARC_WIDTH = 0.3;
const SHINE_ARC_EDGE = 0.25;
const SHINE_INNER_ARC_WIDTH = 0.55;
const SHINE_INNER_ARC_EDGE = 0.125;
const LIGHT_WARMTH = 0.75;
const RAINBOW_SPECTRUM_START = 1.0;
const RAINBOW_SPECTRUM_END = 0.0;
const RAINBOW_CONDENSE = 0.6;
const RING_SAMPLING = 1.0;
const RIM_REFLECTION_STRENGTH = 1.0;
const RIM_REFLECTION_REACH = 1.0;
const RIM_REFLECTION_BEVEL = 1.5;

// Optics and shading constants.
const GLASS_IOR = 1.5;
const MAX_BEVEL_SLOPE = 6.0;
const GLASS_NORMAL_REFLECTANCE = 0.04; // ((ior - 1) / (ior + 1))^2
const RIM_REFLECTION_GROUND_SLOPE_START = 1.0;
const RIM_REFLECTION_GROUND_SLOPE_FULL = 1.5;
const LOUPE_RIM_FRINGE_SPREAD_RATIO = 0.35;
const LOUPE_HOVER_HEIGHT_RATIO01 = 0.25;
const SHADOW_THROW_MAX_REACH_RATIO = 0.45;
const SHADOW_MIN_REACH_RATIO = 0.4;
const LOUPE_SHADOW_LIT_SIDE_KEEP01 = 0.6;
const LOUPE_SHINE_BAND_RATIO01 = 0.036;
const LOUPE_SHINE_BAND_POWER = 2.5;
const LOUPE_SHINE_INNER_REACH_RATIO = 50.0;
const LOUPE_SHINE_INNER_STRENGTH_RATIO = 0.1;
const LOUPE_SHINE_OPPOSITE_RATIO01 = 0.28;
const LOUPE_SHINE_STRENGTH = 1.05;
const LOUPE_SHINE_AMBIENT_RATIO01 = 0.05;
const LOUPE_RIM_DARKEN01 = 0.14;
const RIM_SHINE_DITHER_AMOUNT = 0.8;
const SHINE_DIFFUSE_SHARE = 1.0;
const SHINE_SHEEN_SHARE = 0.35;
const RIM_DIFFUSE_SHARE = 0.9;
const RIM_SHEEN_SHARE = 0.55;
const RAINBOW_SATURATION_RAMP01 = 0.4;
const RAINBOW_MAX_CHROMA = 0.35;
const WARMTH_MAX_CHROMA = 0.25;
const WARMTH_AXIS = vec3f(0.878, -0.023, -0.851);
const LAMP_TINT = vec3f(1.0, 0.98, 0.95);
const FULL_TURN_RADIANS = 6.2831853;
const LOUPE_MAX_EXTRA_LOD = 4.0;
const BLUR_RADIUS_PER_LOD_TEXEL = 0.58;
const INTEGRATOR_SWITCH_SPLIT_DEVICE_PIXELS = 0.75;
const SMEAR_STRATUM_ROTATION = 0.61803398875;
const FRINGE_MAX_READS = 16.0;
const ANTIALIAS_SCREEN_PIXELS = 1.5;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) stage: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  var xy = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VsOut;
  o.pos = vec4f(xy[i], 0.0, 1.0);
  let uv = vec2f((xy[i].x + 1.0) * 0.5, 1.0 - (xy[i].y + 1.0) * 0.5);
  o.stage = uv * L.stageSize;
  return o;
}

// ---- Helpers ---------------------------------------------------------------------------------

fn bayer01(p: vec2f) -> f32 {
  let x = u32(p.x) & 7u;
  let y = u32(p.y) & 7u;
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

fn dither(c: vec4f, frag: vec2f) -> vec4f {
  return vec4f(c.rgb + (bayer01(frag) - 0.5) / 255.0 * c.a, c.a);
}

fn pmaToBlurLinear(c: vec4f) -> vec4f {
  let a = c.a;
  let rgb = clamp(c.rgb, vec3f(0.0), vec3f(a));
  return vec4f(rgb * rgb / max(a, 0.00001), a);
}

fn pmaToDisplay(c: vec4f) -> vec4f {
  return vec4f(sqrt(max(c.rgb * c.a, vec3f(0.0))), c.a);
}

fn blendOver(fg: vec4f, bg: vec4f) -> vec4f { return fg + bg * (1.0 - fg.a); }

fn plainAt(stagePos: vec2f) -> vec4f {
  return textureSampleLevel(plainTex, linearSampler, stagePos / L.stageSize, 0.0);
}

// The magnified scene at a stage position, blurred by `lod` where the rim squeezes the image.
fn loupeViewAt(stagePos: vec2f, lod: f32) -> vec4f {
  let uv = stagePos / L.stageSize;
  if (lod < 0.05) { return textureSampleLevel(magTex, linearSampler, uv, 0.0); }
  let texel = 1.0 / vec2f(textureDimensions(magTex));
  let r = BLUR_RADIUS_PER_LOD_TEXEL * (exp2(lod) - 1.0);
  var acc = textureSampleLevel(magTex, linearSampler, uv, 0.0);
  for (var i = 0; i < 8; i++) {
    let a = f32(i) * 0.7853982;
    acc += textureSampleLevel(magTex, linearSampler, uv + vec2f(cos(a), sin(a)) * r * texel, 0.0);
  }
  return acc / 9.0;
}

fn bevelArcSlope(t: f32, maxSlope: f32) -> f32 {
  return min(t * t * inverseSqrt(1.0 - min(t * t, 0.99)), maxSlope);
}

fn spectrumBumpIntegral(x: f32) -> f32 {
  let c = clamp(x, -1.0, 1.0);
  let s = c * c;
  return c * ((1.0 - s * (2.0 / 3.0)) + s * s * (1.0 / 5.0));
}

// RGB weight of the spectrum slice [s0, s1] (s in -1..1).
fn spectrumBandWeight(s0: f32, s1: f32) -> vec3f {
  let redMain = (spectrumBumpIntegral((s1 - 0.85) / 0.7) - spectrumBumpIntegral((s0 - 0.85) / 0.7)) * 0.7;
  let redViolet = (spectrumBumpIntegral((s1 + 0.95) / 0.35) - spectrumBumpIntegral((s0 + 0.95) / 0.35)) * 0.35;
  let green = (spectrumBumpIntegral((s1 - 0.05) / 0.65) - spectrumBumpIntegral((s0 - 0.05) / 0.65)) * 0.65;
  let blue = (spectrumBumpIntegral((s1 + 0.75) / 0.65) - spectrumBumpIntegral((s0 + 0.75) / 0.65)) * 0.65;
  return vec3f(redMain + 0.3 * redViolet, green, blue);
}

// ---- Lens geometry (video px) ----------------------------------------------------------------

// xy: where to read from, relative to here (magnification + rim refraction); zw: colour split.
fn loupeOffsets(pixel: vec2f) -> vec4f {
  let relative = pixel - L.center;
  let distance = length(relative);
  if (distance >= L.radius || distance < 0.001) { return vec4f(0.0); }
  let magnify = relative * (1.0 - 1.0 / L.zoom);
  let bevelBand = max(L.bevel, 1.0);
  if (distance <= L.radius - bevelBand) { return vec4f(magnify, 0.0, 0.0); }
  let direction = relative / distance;
  let t = clamp((distance - (L.radius - bevelBand)) / bevelBand, 0.0, 1.0);
  let slope = bevelArcSlope(t, MAX_BEVEL_SLOPE);
  let bend = slope * (1.0 - 1.0 / GLASS_IOR) * L.bevel;
  let split = direction * (bend * LOUPE_RIM_FRINGE_SPREAD_RATIO * L.chromaticAberration);
  return vec4f(magnify + direction * bend, split);
}

fn edgeCoverage(pixel: vec2f, aa: f32) -> f32 {
  return clamp((L.radius - length(pixel - L.center)) / max(aa, 0.001), 0.0, 1.0);
}

fn outerShadow(pixel: vec2f) -> f32 {
  if (L.shadowAlpha <= 0.001) { return 0.0; }
  let relative = pixel - L.center;
  let reach = max(L.shadowSize, 1.0);
  let hoverHeight = min(reach, L.radius * LOUPE_HOVER_HEIGHT_RATIO01);
  let shadowThrow = min(L.lightTilt * hoverHeight, reach * SHADOW_THROW_MAX_REACH_RATIO);
  let thrown = length(relative + L.lightDirection * shadowThrow);
  let effectiveReach = max(reach - shadowThrow, reach * SHADOW_MIN_REACH_RATIO);
  let falloff = clamp(1.0 - (thrown - L.radius) / effectiveReach, 0.0, 1.0);
  let facing = dot(relative, L.lightDirection) / max(length(relative), 0.001);
  let litSideFade = mix(1.0, LOUPE_SHADOW_LIT_SIDE_KEEP01, (facing + 1.0) * 0.5);
  return L.shadowAlpha * litSideFade * falloff * falloff;
}

// > 0 inside the light pool the lens throws next to itself.
fn outerPoolDepth(pixel: vec2f) -> f32 {
  let poolPresence = min(L.bevel * 0.5, 1.0) * L.presence;
  if (poolPresence <= 0.001 || OUTER_SHINE_STRENGTH <= 0.0) { return -1.0; }
  let reach = max(L.shadowSize, 1.0);
  let shift = min(L.radius * OUTER_SHINE_SIZE, reach * SHADOW_THROW_MAX_REACH_RATIO);
  return L.radius - length(pixel - L.center + L.lightDirection * shift);
}

// Fresnel reflection of the ground just outside the lens, seen in the steep rim. xy: where to
// read (video px), z: weight.
fn rimReflection(pixel: vec2f) -> vec3f {
  let presenceScale = RIM_REFLECTION_STRENGTH * min(L.bevel * 0.5, 1.0) * L.presence;
  if (presenceScale <= 0.001) { return vec3f(0.0); }
  let relative = pixel - L.center;
  let distance = length(relative);
  if (distance >= L.radius || distance < 0.001) { return vec3f(0.0); }
  let reflectionBevel = min(L.bevel * RIM_REFLECTION_BEVEL, L.radius);
  let band = max(reflectionBevel, 1.0);
  if (distance <= L.radius - band) { return vec3f(0.0); }
  let t = clamp((distance - (L.radius - band)) / band, 0.0, 1.0);
  let slope = bevelArcSlope(t, MAX_BEVEL_SLOPE);
  let cosIncidence = inverseSqrt(1.0 + slope * slope);
  let fresnel = GLASS_NORMAL_REFLECTANCE + (1.0 - GLASS_NORMAL_REFLECTANCE) * pow(1.0 - cosIncidence, 5.0);
  let groundVisibility = smoothstep(RIM_REFLECTION_GROUND_SLOPE_START, RIM_REFLECTION_GROUND_SLOPE_FULL, slope);
  let weight = clamp(fresnel * groundVisibility * presenceScale, 0.0, 1.0);
  if (weight <= 0.004) { return vec3f(0.0); }
  let hoverHeight = L.radius * LOUPE_HOVER_HEIGHT_RATIO01;
  let landingPast = hoverHeight * 2.0 * slope / max(slope * slope - 1.0, 0.05);
  let landing = min(landingPast, L.radius * max(RIM_REFLECTION_REACH, 0.05));
  let sampleDistance = max(distance + landing, L.radius + 1.0);
  return vec3f(L.center + relative / distance * sampleDistance, weight);
}

// Tint of the light pool: white in the middle, a faint rainbow toward its edge.
fn poolLight(t: f32, spanStart: f32, rainbowRatio: f32) -> vec3f {
  let spectral01 = clamp((t - spanStart) / (1.0 - spanStart), 0.0, 1.0);
  let progress = pow(spectral01, max(RAINBOW_CONDENSE, 0.01));
  let hue = mix(RAINBOW_SPECTRUM_START, RAINBOW_SPECTRUM_END, progress) * FULL_TURN_RADIANS;
  let saturationRamp = smoothstep(0.0, RAINBOW_SATURATION_RAMP01, spectral01);
  let amplitude = rainbowRatio * RAINBOW_MAX_CHROMA * saturationRamp;
  let level = mix(POOL_WHITE_LEVEL, 1.0, saturationRamp);
  let warmth = (LIGHT_WARMTH - 0.5) * 2.0 * WARMTH_MAX_CHROMA;
  return vec3f(
    (1.0 + amplitude * cos(hue)) * (1.0 + warmth * WARMTH_AXIS.r),
    (1.0 + amplitude * cos(hue - 2.0943951)) * (1.0 + warmth * WARMTH_AXIS.g),
    (1.0 + amplitude * cos(hue - 4.1887902)) * (1.0 + warmth * WARMTH_AXIS.b)) * level;
}

fn composeRelight(content: vec4f, shadow: f32, light: vec3f, diffuseShare: f32, sheenShare: f32) -> vec4f {
  let diffuseGain = light * diffuseShare;
  let sheenGain = light * sheenShare;
  let multiplier = vec3f(1.0 - shadow) + diffuseGain - sheenGain;
  let sheenAlpha = max(sheenGain.x, max(sheenGain.y, sheenGain.z));
  let lit = content.rgb * multiplier + sheenGain;
  let litPeak = max(lit.x, max(lit.y, lit.z));
  return vec4f(lit / max(litPeak, 1.0), min(content.a + (1.0 - content.a) * shadow + sheenAlpha, 1.0));
}

// Shadow and light pool outside the lens, rim darkening and specular shine on the glass.
fn loupeShading(color: vec4f, pixel: vec2f, coverage: f32, frag: vec2f) -> vec4f {
  let relative = pixel - L.center;
  let distance = length(relative);
  let inverseDistance = 1.0 / max(distance, 0.001);
  let bevelBand = max(L.bevel, 1.0);
  let lightDirection = L.lightDirection;
  var shaded = color;
  let reach = max(L.shadowSize, 1.0);
  var shadow = 0.0;
  if (coverage < 1.0) { shadow = outerShadow(pixel) * (1.0 - coverage); }
  var pool = vec3f(0.0);
  let poolPresence = min(L.bevel * 0.5, 1.0) * L.presence;
  if (poolPresence > 0.001) {
    if (coverage > 0.001) {
      let shift = L.radius * INNER_SHINE_SIZE;
      let depth = length(relative - lightDirection * shift) - L.radius;
      let u = clamp(depth / shift, 0.0, 1.0);
      let amount = u * u * INNER_SHINE_STRENGTH * poolPresence * coverage;
      pool += poolLight(u, INNER_RAINBOW_SPAN_START, INNER_RAINBOW) * amount;
    }
    if (coverage < 1.0) {
      let shift = min(L.radius * OUTER_SHINE_SIZE, reach * SHADOW_THROW_MAX_REACH_RATIO);
      let depth = L.radius - length(relative + lightDirection * shift);
      let u = clamp(depth / shift, 0.0, 1.0);
      let amount = u * u * OUTER_SHINE_STRENGTH * poolPresence * (1.0 - coverage);
      pool += poolLight(1.0 - u, OUTER_RAINBOW_SPAN_START, OUTER_RAINBOW) * amount;
    }
  }
  if (shadow + pool.x + pool.y + pool.z > 0.0) {
    shaded = composeRelight(shaded, shadow, LAMP_TINT * pool, SHINE_DIFFUSE_SHARE, SHINE_SHEEN_SHARE);
  }
  if (coverage <= 0.0 || distance >= L.radius || distance < 0.001) { return shaded; }

  let polishBandScale = pow(3.0, (0.5 - SHINE_POLISH) * 2.0);
  let shineBand = max(L.radius * LOUPE_SHINE_BAND_RATIO01 * polishBandScale, 1.0);
  let innerShineBand = shineBand * LOUPE_SHINE_INNER_REACH_RATIO;
  if (distance < L.radius - max(bevelBand, innerShineBand)) { return shaded; }
  let direction = relative * inverseDistance;
  let t = clamp((distance - (L.radius - bevelBand)) / bevelBand, 0.0, 1.0);
  let bevelPresence = min(L.bevel * 0.5, 1.0);
  let facing = dot(direction, lightDirection);
  let backFacing = max(-facing, 0.0);
  let rimWeight = t * t * bevelPresence * coverage;
  let rimDistance = L.radius - distance;
  let coreBand = pow(clamp(1.0 - rimDistance / shineBand, 0.0, 1.0), LOUPE_SHINE_BAND_POWER);
  let innerU = clamp(1.0 - rimDistance / innerShineBand, 0.0, 1.0);
  let innerBand = innerU * innerU * (3.0 - 2.0 * innerU) * LOUPE_SHINE_INNER_STRENGTH_RATIO;
  let lit = max(facing, 0.0);
  let lightSoftness = clamp(4.0 / max(L.shineExponent, 1.0), 0.0, 1.0);

  let edgeWidth = clamp(SHINE_ARC_WIDTH, 0.05, 1.0);
  let edgeStart = 1.0 - edgeWidth;
  let edgeFeather = max(mix(edgeWidth, 0.02, clamp(SHINE_ARC_EDGE, 0.0, 1.0)) * (1.0 + lightSoftness * 0.5), 0.01);
  let edgePrimary = smoothstep(edgeStart, edgeStart + edgeFeather, lit);
  let edgeSecondary = LOUPE_SHINE_OPPOSITE_RATIO01 * smoothstep(edgeStart + edgeWidth * 0.25, edgeStart + edgeFeather + edgeWidth * 0.25, backFacing);
  let innerWidth = clamp(SHINE_INNER_ARC_WIDTH, 0.05, 1.0);
  let innerStart = 1.0 - innerWidth;
  let innerFeather = max(mix(innerWidth, 0.02, clamp(SHINE_INNER_ARC_EDGE, 0.0, 1.0)) * (1.0 + lightSoftness * 0.5), 0.01);
  let innerPrimary = smoothstep(innerStart, innerStart + innerFeather, lit);
  let innerSecondary = LOUPE_SHINE_OPPOSITE_RATIO01 * smoothstep(innerStart + innerWidth * 0.25, innerStart + innerFeather + innerWidth * 0.25, backFacing);

  let primaryMask = edgePrimary * coreBand + innerPrimary * innerBand;
  let secondaryMask = edgeSecondary * coreBand + innerSecondary * innerBand;
  let ambientBand = coreBand + innerBand;
  let surfaceWeight = bevelPresence * coverage * L.presence * LOUPE_SHINE_STRENGTH;
  let rimLight = (LAMP_TINT * primaryMask + LAMP_TINT * vec3f(0.9, 0.96, 1.05) * secondaryMask + LAMP_TINT * (LOUPE_SHINE_AMBIENT_RATIO01 * ambientBand)) * surfaceWeight;
  let dithered = rimLight * (1.0 + (bayer01(frag) - 0.5) * RIM_SHINE_DITHER_AMOUNT);
  var rimShaded = vec4f(shaded.rgb * (1.0 - LOUPE_RIM_DARKEN01 * rimWeight), shaded.a);
  if (dithered.x + dithered.y + dithered.z > 0.0) {
    rimShaded = composeRelight(rimShaded, 0.0, dithered, RIM_DIFFUSE_SHARE, RIM_SHEEN_SHARE);
  }
  return rimShaded;
}

// How much the rim squeezes the image at this pixel, as a blur level (log2 of the minification).
fn sampleLodBias(pixel: vec2f, rawDisplacement: vec2f) -> f32 {
  let relative = pixel - L.center;
  let distance = length(relative);
  if (distance >= L.radius) { return 0.0; }
  var scale = 1.0 / max(L.zoom, 0.05);
  let bevelBand = max(L.bevel, 1.0);
  if (distance >= 1.0 && distance > L.radius - bevelBand) {
    let direction = relative / distance;
    let sampleHere = pixel - rawDisplacement;
    let inwardPixel = pixel - direction;
    let sampleInward = inwardPixel - loupeOffsets(inwardPixel).xy;
    scale = max(length(sampleHere - sampleInward), length(sampleHere - L.center) / distance);
  }
  return clamp(log2(max(scale, 0.01)), -2.0, LOUPE_MAX_EXTRA_LOD);
}

// ---- Fragment --------------------------------------------------------------------------------

fn loupeLayer(p: vec2f, frag: vec2f) -> vec4f {
  let jitter = bayer01(frag);
  let videoPixel = (p - L.screen.xy) / L.screen.zw * L.videoSize;
  let stagePerVideo = L.screen.z / L.videoSize.x;
  let aa = ANTIALIAS_SCREEN_PIXELS / (L.pxPerUnit * max(stagePerVideo, 0.000001));
  let toLoupe = videoPixel - L.center;
  let reach = L.radius + L.shadowSize + aa;
  if (dot(toLoupe, toLoupe) > reach * reach) { return vec4f(0.0); }

  let coverage = edgeCoverage(videoPixel, aa);
  if (coverage <= 0.0) {
    if (outerPoolDepth(videoPixel) > 0.0) {
      return dither(loupeShading(plainAt(p), videoPixel, 0.0, frag), frag);
    }
    let shadow = outerShadow(videoPixel);
    if (shadow <= 0.0) { return vec4f(0.0); }
    let noise = bayer01(frag + vec2f(4.0, 4.0)) / 255.0 * min(shadow * 64.0, 1.0);
    let ditheredShadow = clamp(shadow + (jitter - 0.5) * (1.5 / 255.0) * shadow, 0.0, 1.0);
    return vec4f(noise, noise, noise, ditheredShadow);
  }

  let offsets = loupeOffsets(videoPixel);
  var magnify = vec2f(0.0);
  let distance = length(toLoupe);
  if (distance < L.radius && distance >= 0.001) { magnify = toLoupe * (1.0 - 1.0 / L.zoom); }
  // magTex is already magnified, so read it with the rim bend only.
  let bendOnly = offsets.xy - magnify;
  let lod = clamp(sampleLodBias(videoPixel, offsets.xy) + log2(max(L.zoom, 0.05)), 0.0, LOUPE_MAX_EXTRA_LOD);
  let readAt = p - bendOnly * stagePerVideo;

  let splitStage = offsets.zw * stagePerVideo;
  let splitDevice2 = dot(splitStage, splitStage) * L.pxPerUnit * L.pxPerUnit;
  var inside = vec4f(0.0);
  if (splitDevice2 < INTEGRATOR_SWITCH_SPLIT_DEVICE_PIXELS * INTEGRATOR_SWITCH_SPLIT_DEVICE_PIXELS) {
    inside = loupeViewAt(readAt, lod);
  } else {
    // Colour fringe: spread reads along the split and weight each by its slice of the spectrum.
    let sampleBoost = max(RING_SAMPLING, 0.25);
    let budget = min(L.fringeReads, FRINGE_MAX_READS) * max(sampleBoost, 1.0);
    let reads = i32(clamp(ceil(sqrt(splitDevice2)) * sampleBoost, 3.0, budget));
    let inverseReads = 1.0 / f32(reads);
    var color = vec3f(0.0);
    var colorWeight = vec3f(0.0);
    var alpha = 0.0;
    for (var i = 0; i < reads; i++) {
      let bandEnd = 1.0 - f32(i) * inverseReads * 2.0;
      let bandStart = bandEnd - inverseReads * 2.0;
      let s = bandEnd - fract(jitter + f32(i) * SMEAR_STRATUM_ROTATION) * inverseReads * 2.0;
      let linear = pmaToBlurLinear(loupeViewAt(readAt + splitStage * s, lod));
      let weight = spectrumBandWeight(bandStart, bandEnd);
      color += linear.rgb * weight;
      colorWeight += weight;
      alpha += linear.a;
    }
    inside = pmaToDisplay(vec4f(color / colorWeight, alpha / f32(reads)));
  }

  let reflection = rimReflection(videoPixel);
  if (reflection.z > 0.0) {
    let reflected = plainAt(p + (reflection.xy - videoPixel) * stagePerVideo);
    let reflectedShadow = outerShadow(reflection.xy);
    inside = mix(inside, vec4f(reflected.rgb * (1.0 - reflectedShadow), reflected.a), reflection.z);
  }
  if (coverage >= 1.0) { return dither(loupeShading(inside, videoPixel, 1.0, frag), frag); }
  let mixed = mix(plainAt(p), inside, coverage);
  return dither(loupeShading(mixed, videoPixel, coverage, frag), frag);
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let plain = plainAt(in.stage);
  return blendOver(loupeLayer(in.stage, in.pos.xy), plain);
}
