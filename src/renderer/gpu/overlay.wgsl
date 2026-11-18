// Blits a premultiplied overlay texture (the keyboard shortcut keycaps) over the frame. The
// pipeline blends with premultiplied "over".

@group(0) @binding(0) var linearSampler: sampler;
@group(0) @binding(1) var overlayTex: texture_2d<f32>;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  var xy = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VsOut;
  o.pos = vec4f(xy[i], 0.0, 1.0);
  o.uv = vec2f((xy[i].x + 1.0) * 0.5, 1.0 - (xy[i].y + 1.0) * 0.5);
  return o;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  return textureSampleLevel(overlayTex, linearSampler, in.uv, 0.0);
}
