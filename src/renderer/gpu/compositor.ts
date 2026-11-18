// WebGPU compositor: owns the device, textures and pipelines, and draws one frame from
// FrameInputs (built by frame-inputs.ts) into a canvas or export texture.
//
// Normally one full-stage pass. With a glass loupe on screen it takes three: the scene, the scene
// magnified about the lens centre (so magnified text stays sharp), then the loupe pass that
// combines them.

import shaderSource from './compositor.wgsl';
import loupeSource from './loupe.wgsl';
import overlaySource from './overlay.wgsl';
import type { FrameInputs, LoupeInputs, RectV } from '../../core/scene/frame-inputs';
import { squircleLutCached } from '../../core/geometry/squircle';

const PARAM_FLOATS = 164; // multiple of 4
const LOUPE_PARAM_FLOATS = 28;

interface Pipelines {
  scene: GPURenderPipeline;
  loupe: GPURenderPipeline;
  overlay: GPURenderPipeline; // scene shader blended over the target (webcam above the loupe)
  keycaps: GPURenderPipeline; // overlay texture blended over the finished frame
}

const enum DrawMode {
  All = 0,
  WithoutCamera = 1,
  CameraOnly = 2,
}

export class Compositor {
  private constructor(
    readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
    private readonly sampler: GPUSampler,
    private readonly sceneModule: GPUShaderModule,
    private readonly loupeModule: GPUShaderModule,
    private readonly overlayModule: GPUShaderModule,
  ) {
    this.params = this.uniformBuffer(PARAM_FLOATS);
    this.magnifiedParams = this.uniformBuffer(PARAM_FLOATS);
    this.loupeParams = this.uniformBuffer(LOUPE_PARAM_FLOATS);
    this.cameraParams = this.uniformBuffer(PARAM_FLOATS);
  }

  private pipelines = new Map<GPUTextureFormat, Pipelines>();
  private readonly params: GPUBuffer;
  private readonly magnifiedParams: GPUBuffer;
  private readonly loupeParams: GPUBuffer;
  private readonly cameraParams: GPUBuffer;
  private plainTarget: GPUTexture | null = null;
  private magnifiedTarget: GPUTexture | null = null;

  private screenTex: GPUTexture | null = null;
  private cursorTex!: GPUTexture;
  private bgTex!: GPUTexture;
  private cameraTex: GPUTexture | null = null;
  private overlayTex: GPUTexture | null = null;
  private cameraLutTex: GPUTexture | null = null;
  private cameraMaskTex: GPUTexture | null = null;
  private hasCameraMask = false;
  private noLutTex: GPUTexture | null = null;
  private hasOverlay = false;
  private hasCameraFrame = false;
  private bgSize: [number, number] = [1, 1];
  private cursorKey: string | null = null;
  private data = new Float32Array(PARAM_FLOATS);
  private loupeData = new Float32Array(LOUPE_PARAM_FLOATS);

  // Which GPU (or software adapter) is in use, for logs and the self-test report.
  static adapterInfo = '';

  static async create(): Promise<Compositor> {
    if (!navigator.gpu) throw new Error('WebGPU is not available on this system.');
    // Fall back to the software adapter on machines without a usable GPU (VMs, CI runners).
    const adapter = (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })) ?? (await navigator.gpu.requestAdapter({ forceFallbackAdapter: true }));
    if (!adapter) throw new Error('No WebGPU adapter found. Update your graphics driver. (On a machine without a GPU, start the app with RECORDER_SOFTWARE_GPU=1.)');
    Compositor.adapterInfo = `${adapter.info.vendor || 'unknown vendor'} ${adapter.info.architecture || ''} ${adapter.info.description || ''}`.trim();
    const device = await adapter.requestDevice();
    const format = navigator.gpu.getPreferredCanvasFormat();
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const c = new Compositor(device, format, sampler, device.createShaderModule({ code: shaderSource }), device.createShaderModule({ code: loupeSource }), device.createShaderModule({ code: overlaySource }));
    c.cursorTex = c.solidTexture([0, 0, 0, 0]);
    c.bgTex = c.solidTexture([0, 0, 0, 255]);
    return c;
  }

  // Size of the current screen frame in pixels (the loupe works in these units).
  get screenSize(): { width: number; height: number } | null {
    return this.screenTex ? { width: this.screenTex.width, height: this.screenTex.height } : null;
  }

  private uniformBuffer(floats: number): GPUBuffer {
    return this.device.createBuffer({ size: floats * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  // Pipelines per output format (the canvas and the export texture may differ).
  private pipelinesFor(format: GPUTextureFormat): Pipelines {
    let p = this.pipelines.get(format);
    if (!p) {
      const premultipliedOver: GPUBlendState = {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      };
      const make = (module: GPUShaderModule, blend?: GPUBlendState) =>
        this.device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format, blend }] },
          primitive: { topology: 'triangle-list' },
        });
      p = { scene: make(this.sceneModule), loupe: make(this.loupeModule), overlay: make(this.sceneModule, premultipliedOver), keycaps: make(this.overlayModule, premultipliedOver) };
      this.pipelines.set(format, p);
    }
    return p;
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

  // Premultiplied overlay drawn over the finished frame (keycaps), or null for none.
  setOverlay(source: OffscreenCanvas | null): void {
    this.hasOverlay = source !== null;
    if (!source) return;
    if (!this.overlayTex || this.overlayTex.width !== source.width || this.overlayTex.height !== source.height) {
      this.overlayTex?.destroy();
      this.overlayTex = this.device.createTexture({ size: [source.width, source.height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    }
    this.device.queue.copyExternalImageToTexture({ source }, { texture: this.overlayTex, premultipliedAlpha: true }, [source.width, source.height]);
  }

  // 3D colour LUT for the webcam (size³ RGB, 0..1), or null for none.
  setCameraLut(lut: { size: number; data: Float32Array } | null): void {
    this.cameraLutTex?.destroy();
    this.cameraLutTex = null;
    if (!lut) return;
    const n = lut.size;
    const rgba = new Uint8Array(n * n * n * 4);
    for (let i = 0; i < n * n * n; i++) {
      for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.round(Math.min(1, Math.max(0, lut.data[i * 3 + c])) * 255);
      rgba[i * 4 + 3] = 255;
    }
    this.cameraLutTex = this.device.createTexture({ size: [n, n, n], dimension: '3d', format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.device.queue.writeTexture({ texture: this.cameraLutTex }, rgba, { bytesPerRow: n * 4, rowsPerImage: n }, [n, n, n]);
  }

  // Person mask for the cutout layout (0..255 per pixel), or null for none.
  setCameraMask(mask: { width: number; height: number; data: Uint8Array<ArrayBuffer> } | null): void {
    this.hasCameraMask = mask !== null;
    if (!mask) return;
    if (!this.cameraMaskTex || this.cameraMaskTex.width !== mask.width || this.cameraMaskTex.height !== mask.height) {
      this.cameraMaskTex?.destroy();
      this.cameraMaskTex = this.device.createTexture({ size: [mask.width, mask.height], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    }
    this.device.queue.writeTexture({ texture: this.cameraMaskTex }, mask.data, { bytesPerRow: mask.width }, [mask.width, mask.height]);
  }

  private lutView(): GPUTextureView {
    if (this.cameraLutTex) return this.cameraLutTex.createView();
    this.noLutTex ??= this.device.createTexture({ size: [1, 1, 1], dimension: '3d', format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
    return this.noLutTex.createView();
  }

  // null: no webcam frame at this time (before the webcam started, or no webcam).
  setCameraFrame(frame: VideoFrame | null): void {
    this.hasCameraFrame = frame !== null && frame.displayWidth > 0;
    if (frame && this.hasCameraFrame) this.cameraTex = this.uploadImage(frame, frame.displayWidth, frame.displayHeight, this.cameraTex);
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
    const pipes = this.pipelinesFor(target.format);
    const enc = this.device.createCommandEncoder();
    if (!f.loupe) {
      this.writeParams(this.params, f, pxPerUnit, null, DrawMode.All);
      this.drawScene(enc, pipes.scene, this.params, target);
    } else {
      this.plainTarget = this.offscreen(this.plainTarget, target);
      this.magnifiedTarget = this.offscreen(this.magnifiedTarget, target);
      this.writeParams(this.params, f, pxPerUnit, null, DrawMode.WithoutCamera);
      this.writeParams(this.magnifiedParams, f, pxPerUnit, f.loupe, DrawMode.WithoutCamera);
      this.writeLoupeParams(f, f.loupe, pxPerUnit);
      this.drawScene(enc, pipes.scene, this.params, this.plainTarget);
      this.drawScene(enc, pipes.scene, this.magnifiedParams, this.magnifiedTarget);
      const bind = this.device.createBindGroup({
        layout: pipes.loupe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.loupeParams } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: this.plainTarget.createView() },
          { binding: 3, resource: this.magnifiedTarget.createView() },
        ],
      });
      this.fullScreenPass(enc, pipes.loupe, bind, target, 'clear');
      if (f.camera) {
        this.writeParams(this.cameraParams, f, pxPerUnit, null, DrawMode.CameraOnly);
        this.drawScene(enc, pipes.overlay, this.cameraParams, target, 'load');
      }
    }
    if (this.hasOverlay && this.overlayTex) {
      const bind = this.device.createBindGroup({
        layout: pipes.keycaps.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: this.overlayTex.createView() },
        ],
      });
      this.fullScreenPass(enc, pipes.keycaps, bind, target, 'load');
    }
    this.device.queue.submit([enc.finish()]);
  }

  private offscreen(existing: GPUTexture | null, like: GPUTexture): GPUTexture {
    if (existing && existing.width === like.width && existing.height === like.height && existing.format === like.format) return existing;
    existing?.destroy();
    return this.device.createTexture({ size: [like.width, like.height], format: like.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  }

  private drawScene(enc: GPUCommandEncoder, pipeline: GPURenderPipeline, params: GPUBuffer, target: GPUTexture, load: GPULoadOp = 'clear'): void {
    const bind = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: (this.screenTex ?? this.bgTex).createView() },
        { binding: 3, resource: this.cursorTex.createView() },
        { binding: 4, resource: this.bgTex.createView() },
        { binding: 5, resource: (this.cameraTex ?? this.bgTex).createView() },
        { binding: 6, resource: this.lutView() },
        { binding: 7, resource: (this.cameraMaskTex ?? this.bgTex).createView() },
      ],
    });
    this.fullScreenPass(enc, pipeline, bind, target, load);
  }

  private fullScreenPass(enc: GPUCommandEncoder, pipeline: GPURenderPipeline, bind: GPUBindGroup, target: GPUTexture, load: GPULoadOp): void {
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: load, storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
  }

  // Field order and offsets must match struct Params in compositor.wgsl.
  // `magnified`: draw the scene magnified about the loupe centre instead.
  private writeParams(buffer: GPUBuffer, f: FrameInputs, pxPerUnit: number, magnified: LoupeInputs | null, mode: DrawMode): void {
    const d = this.data;
    d.fill(0);
    const rect = (o: number, r: RectV) => d.set([r.x, r.y, r.width, r.height], o);
    const viewScale = magnified ? magnified.zoom : 1;
    d.set([f.stage.width, f.stage.height, pxPerUnit * viewScale, 0], 0);
    rect(4, f.screenNow);
    rect(8, f.screenBefore);
    d.set([f.screenRadius, f.motionBlurTaps, 1, f.hasScreen && this.screenTex ? 1 : 0], 12);
    const s = f.shadow;
    d.set([...s.color, s.alpha], 16);
    d.set([...s.offset, s.blur, s.directional ? 1 : 0], 20);
    d.set([...s.light, s.lightRadius, s.falloff], 24);
    const bg = f.background;
    d.set([{ color: 0, gradient: 1, image: 2, mesh: 3 }[bg.type], Math.min(8, bg.stops.length), bg.blur, bg.scale], 28);
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
    d.set([Math.min(3, f.clicks.length), f.clickStyle === 'circle' ? 1 : f.clickStyle === 'ripple' ? 2 : 0, f.screenNow.width, f.ripplePull01], 88);
    f.clicks.slice(0, 3).forEach((k, i) => d.set([k.x, k.y, k.age01, 0], 92 + i * 4));
    d.set([...(magnified ? magnified.magnifyCenter : [0, 0]), viewScale, mode], 104);
    const cam = f.camera;
    if (cam && this.cameraTex && this.hasCameraFrame) {
      rect(108, cam.now);
      rect(112, cam.before);
      d.set([cam.radius, cam.opacity, cam.mirror ? 1 : 0, 1], 116);
      d.set([this.cameraTex.width, this.cameraTex.height, 0, 0], 120);
      d.set(squircleLutCached(cam.now.width, cam.now.height, cam.radius), 140);
      d.set([cam.grain, cam.grainSeed, this.cameraLutTex ? cam.lutIntensity : 0, 0], 156);
      d.set([...cam.focus, cam.cutout && this.hasCameraMask && this.cameraMaskTex ? 1 : 0, 0], 160);
    }
    d.set(squircleLutCached(f.screenNow.width, f.screenNow.height, f.screenRadius), 124);
    this.device.queue.writeBuffer(buffer, 0, d);
  }

  // Field order and offsets must match struct LoupeParams in loupe.wgsl.
  private writeLoupeParams(f: FrameInputs, l: LoupeInputs, pxPerUnit: number): void {
    const d = this.loupeData;
    const v = f.screenNow;
    d.set([f.stage.width, f.stage.height, pxPerUnit, l.fringeReads], 0);
    d.set([v.x, v.y, v.width, v.height], 4);
    d.set([...l.videoSize, ...l.center], 8);
    d.set([l.radius, l.bevel, l.zoom, l.chromaticAberration], 12);
    d.set([...l.lightDirection, l.shineExponent, l.lightTilt], 16);
    d.set([l.shadowAlpha, l.shadowSize, l.presence, 0], 20);
    d.set([...l.magnifyCenter, 0, 0], 24);
    this.device.queue.writeBuffer(this.loupeParams, 0, d);
  }
}
