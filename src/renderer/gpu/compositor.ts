// WebGPU compositor: owns the device, textures and the single full-stage pipeline, and draws one
// frame from FrameInputs (built by frame-inputs.ts) into a canvas.

import shaderSource from './compositor.wgsl';
import type { FrameInputs, RectV } from '../../core/scene/frame-inputs';

const PARAM_FLOATS = 104;

export class Compositor {
  private constructor(
    readonly device: GPUDevice,
    private readonly pipeline: GPURenderPipeline,
    private readonly sampler: GPUSampler,
    private readonly params: GPUBuffer,
    private readonly format: GPUTextureFormat,
  ) {}

  private screenTex: GPUTexture | null = null;
  private cursorTex!: GPUTexture;
  private bgTex!: GPUTexture;
  private bgSize: [number, number] = [1, 1];
  private cursorKey: string | null = null;
  private data = new Float32Array(PARAM_FLOATS);

  static async create(): Promise<Compositor> {
    if (!navigator.gpu) throw new Error('WebGPU is not available on this system.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    const device = await adapter.requestDevice();
    const format = navigator.gpu.getPreferredCanvasFormat();
    const module = device.createShaderModule({ code: shaderSource });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const params = device.createBuffer({ size: PARAM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const c = new Compositor(device, pipeline, sampler, params, format);
    c.cursorTex = c.solidTexture([0, 0, 0, 0]);
    c.bgTex = c.solidTexture([0, 0, 0, 255]);
    return c;
  }

  configure(ctx: GPUCanvasContext): void {
    ctx.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
  }

  private solidTexture(rgba: number[]): GPUTexture {
    const t = this.device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.device.queue.writeTexture({ texture: t }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1]);
    return t;
  }

  private uploadImage(source: ImageBitmap | VideoFrame | HTMLVideoElement, width: number, height: number, existing: GPUTexture | null): GPUTexture {
    let tex = existing;
    if (!tex || tex.width !== width || tex.height !== height) {
      tex?.destroy();
      tex = this.device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    this.device.queue.copyExternalImageToTexture({ source }, { texture: tex }, [width, height]);
    return tex;
  }

  setScreenFrame(frame: VideoFrame | HTMLVideoElement): void {
    const w = frame instanceof VideoFrame ? frame.displayWidth : frame.videoWidth;
    const h = frame instanceof VideoFrame ? frame.displayHeight : frame.videoHeight;
    if (!w || !h) return;
    this.screenTex = this.uploadImage(frame, w, h, this.screenTex);
  }

  setCursorImage(key: string, img: ImageBitmap): void {
    if (this.cursorKey === key) return;
    this.cursorTex.destroy();
    this.cursorTex = this.uploadImage(img, img.width, img.height, null);
    this.cursorKey = key;
  }

  setBackgroundImage(img: ImageBitmap | null): void {
    this.bgTex.destroy();
    if (img) {
      this.bgTex = this.uploadImage(img, img.width, img.height, null);
      this.bgSize = [img.width, img.height];
    } else {
      this.bgTex = this.solidTexture([0, 0, 0, 255]);
      this.bgSize = [1, 1];
    }
  }

  render(target: GPUTexture, f: FrameInputs, pxPerUnit: number): void {
    this.writeParams(f, pxPerUnit);
    const bind = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: (this.screenTex ?? this.bgTex).createView() },
        { binding: 3, resource: this.cursorTex.createView() },
        { binding: 4, resource: this.bgTex.createView() },
      ],
    });
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  // Field order and offsets must match struct Params in compositor.wgsl.
  private writeParams(f: FrameInputs, pxPerUnit: number): void {
    const d = this.data;
    d.fill(0);
    const rect = (o: number, r: RectV) => d.set([r.x, r.y, r.width, r.height], o);
    d.set([f.stage.width, f.stage.height, pxPerUnit, 0], 0);
    rect(4, f.screenNow);
    rect(8, f.screenBefore);
    d.set([f.screenRadius, f.motionBlurTaps, 1, f.hasScreen && this.screenTex ? 1 : 0], 12);
    const s = f.shadow;
    d.set([...s.color, s.alpha], 16);
    d.set([...s.offset, s.blur, s.directional ? 1 : 0], 20);
    d.set([...s.light, s.lightRadius, s.falloff], 24);
    const bg = f.background;
    d.set([bg.type === 'color' ? 0 : bg.type === 'gradient' ? 1 : 2, Math.min(8, bg.stops.length), bg.blur, bg.scale], 28);
    d.set([...bg.origin, ...bg.start], 32);
    d.set([...bg.end, ...this.bgSize], 36);
    bg.stops.slice(0, 8).forEach((st, i) => d.set([...st.rgb, st.at], 40 + i * 4));
    const c = f.cursor;
    if (c) {
      rect(72, c.now);
      rect(76, c.before);
      d.set([...c.pivotNow, ...c.pivotBefore], 80);
      d.set([c.angleNow, c.angleBefore, c.opacity, c.fadeBlur], 84);
    }
    d.set([Math.min(3, f.clicks.length), f.clickStyle === 'circle' ? 1 : 0, f.screenNow.width, 0], 88);
    f.clicks.slice(0, 3).forEach((k, i) => d.set([k.x, k.y, k.age01, 0], 92 + i * 4));
    this.device.queue.writeBuffer(this.params, 0, d);
  }
}
