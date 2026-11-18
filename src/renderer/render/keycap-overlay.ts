// Draws the keyboard shortcut keycaps (core/keyboard/shortcuts.ts) with Canvas 2D at output
// resolution. The look follows the reference's keycap SVG: a 3/256 rim with a light-to-dark
// gradient around a dark body, white symbol and label, and a soft drop shadow.

import type { KeyCapDraw } from '../../core/keyboard/shortcuts';

const RIM_RATIO = 3 / 256;
const INNER_RADIUS_RATIO = 29 / 32;
const SYMBOL_SIZE = 0.33;
const LABEL_SIZE = 0.225;
const PADDING = 0.125;
const FONT = "-apple-system, 'SF Pro Display', 'Segoe UI', system-ui, sans-serif";

export class KeycapCanvas {
  readonly canvas = new OffscreenCanvas(1, 1);
  private readonly g = this.canvas.getContext('2d')!;

  // Returns false (and draws nothing) when no keycap is visible.
  draw(caps: KeyCapDraw[], stage: { width: number; height: number }, width: number, height: number, sizeRatio: number): boolean {
    if (caps.length === 0) return false;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const g = this.g;
    const s = height / stage.height; // device px per stage unit
    g.clearRect(0, 0, width, height);
    for (const c of caps) {
      const x = c.rect.x * s;
      const y = c.rect.y * s;
      const w = c.rect.width * s;
      const h = c.rect.height * s;
      const r = Math.min(c.cornerRadius * s, h / 2);
      g.save();
      g.globalAlpha = c.opacity;
      g.shadowColor = 'rgba(0, 0, 0, 0.33)';
      g.shadowBlur = sizeRatio * 200 * s;
      g.shadowOffsetY = sizeRatio * 25 * s;
      const rim = g.createLinearGradient(0, y, 0, y + h);
      rim.addColorStop(0, '#656565');
      rim.addColorStop(1, '#191919');
      g.fillStyle = rim;
      g.beginPath();
      g.roundRect(x, y, w, h, r);
      g.fill();
      g.shadowColor = 'transparent';
      const inset = h * RIM_RATIO;
      const body = { x: x + inset, y: y + inset, w: w - inset * 2, h: h - inset * 2 };
      const fill = g.createLinearGradient(0, body.y, 0, body.y + body.h);
      fill.addColorStop(0, '#2b2b2b');
      fill.addColorStop(1, '#191919');
      g.fillStyle = fill;
      g.beginPath();
      g.roundRect(body.x, body.y, body.w, body.h, r * INNER_RADIUS_RATIO);
      g.fill();
      this.text(c, body);
      g.restore();
    }
    return true;
  }

  private text(c: KeyCapDraw, body: { x: number; y: number; w: number; h: number }): void {
    const g = this.g;
    const pad = body.h * PADDING;
    const room = body.w - pad * 2;
    g.fillStyle = '#ffffff';
    const fit = (text: string, size: number, weight: string) => {
      g.font = `${weight} ${size}px ${FONT}`;
      const w = g.measureText(text).width;
      if (w > room) g.font = `${weight} ${(size * room) / w}px ${FONT}`;
    };
    if (c.cap.placement === 'center') {
      fit(c.cap.label, body.h * SYMBOL_SIZE, '400');
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(c.cap.label, body.x + body.w / 2, body.y + body.h / 2);
      return;
    }
    const centred = c.cap.placement === 'bottom-center';
    g.textAlign = centred ? 'center' : 'left';
    const tx = centred ? body.x + body.w / 2 : body.x + pad;
    if (c.cap.symbol) {
      g.font = `400 ${body.h * SYMBOL_SIZE}px ${FONT}`;
      g.textBaseline = 'top';
      g.fillText(c.cap.symbol, tx, body.y + pad);
    }
    if (c.cap.label) {
      fit(c.cap.label, body.h * LABEL_SIZE, '500');
      g.textBaseline = 'bottom';
      g.fillText(c.cap.label, tx, body.y + body.h - pad);
    }
  }
}
