// Right-hand settings panel, organised in tabs. Every control edits the project through the
// editor controller.

import { useState } from 'react';
import { SPRING_PRESETS, type SpringConfig } from '../../core/animation/spring';
import type { Zoom } from '../../core/project/model';
import { Button, Row, Segmented, Slider, Switch } from '../ui/controls';
import { CursorIcon, ImageIcon, MotionIcon, RestoreIcon, TrashIcon, WaveIcon, ZoomIcon } from '../ui/icons';
import type { EditorController } from './editor-controller';

const GRADIENTS: [string, string][] = [
  ['#4776e6', '#8e54e9'],
  ['#ff7e5f', '#feb47b'],
  ['#00c9ff', '#92fe9d'],
  ['#fc466b', '#3f5efb'],
  ['#11998e', '#38ef7d'],
  ['#ee9ca7', '#ffdde1'],
  ['#232526', '#414345'],
  ['#0f2027', '#2c5364'],
  ['#f7971e', '#ffd200'],
  ['#8e2de2', '#4a00e0'],
];
const COLORS = ['#0b0b0d', '#ffffff', '#f4f1ea', '#1f6feb', '#7c3aed', '#16a34a'];

const CURSOR_SMOOTHING: { value: string; label: string; spring: SpringConfig | null }[] = [
  { value: 'default', label: 'Default', spring: SPRING_PRESETS.default },
  { value: 'smooth', label: 'Smooth', spring: SPRING_PRESETS.smooth },
  { value: 'rapid', label: 'Rapid', spring: SPRING_PRESETS.rapid },
  { value: 'none', label: 'Off', spring: null },
];
const SCREEN_MOVEMENT: { value: string; label: string; spring: SpringConfig }[] = [
  { value: 'default', label: 'Default', spring: SPRING_PRESETS.default },
  { value: 'smooth', label: 'Smooth', spring: SPRING_PRESETS.screenSmooth },
  { value: 'focused', label: 'Snappy', spring: SPRING_PRESETS.screenFocused },
];

function presetOf<T extends { spring: SpringConfig | null }>(list: T[], s: SpringConfig | null): T | undefined {
  return list.find((p) => (p.spring === null || s === null ? p.spring === s : p.spring.stiffness === s.stiffness && p.spring.damping === s.damping && p.spring.mass === s.mass));
}

type Tab = 'background' | 'cursor' | 'motion' | 'audio';

export function Inspector({ editor, selectedZoom, onDeselect }: { editor: EditorController; selectedZoom: Zoom | null; onDeselect: () => void }) {
  const [tab, setTab] = useState<Tab>('background');
  const c = editor.project.config;
  const edit = editor.updateConfig.bind(editor);

  return (
    <aside className="inspector">
      {selectedZoom ? (
        <ZoomPanel editor={editor} zoom={selectedZoom} onDone={onDeselect} />
      ) : (
        <>
          <Segmented
            label="Settings"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'background', label: (
                  <span className="tab-label">
                    <ImageIcon size={14} />
                    Style
                  </span>
                ) },
              { value: 'cursor', label: (
                  <span className="tab-label">
                    <CursorIcon size={14} />
                    Cursor
                  </span>
                ) },
              { value: 'motion', label: (
                  <span className="tab-label">
                    <MotionIcon size={14} />
                    Motion
                  </span>
                ) },
              { value: 'audio', label: (
                  <span className="tab-label">
                    <WaveIcon size={14} />
                    Audio
                  </span>
                ) },
            ]}
          />
          <div className="panel" key={tab}>
            {tab === 'background' && (
              <>
                <h3>Background</h3>
                <div className="swatch-grid">
                  {GRADIENTS.map(([a, b]) => {
                    const active = c.styles.background.type === 'gradient' && c.styles.background.gradient.stops[0]?.color === a && c.styles.background.gradient.stops[1]?.color === b;
                    return (
                      <button
                        key={a + b}
                        aria-label={`Gradient ${a} to ${b}`}
                        className={`swatch ${active ? 'active' : ''}`}
                        style={{ background: `linear-gradient(135deg, ${a}, ${b})` }}
                        onClick={() =>
                          edit((cfg) => {
                            cfg.styles.background.type = 'gradient';
                            cfg.styles.background.gradient.stops = [
                              { color: a, at: 0 },
                              { color: b, at: 1 },
                            ];
                          })
                        }
                      />
                    );
                  })}
                </div>
                <div className="swatch-grid small">
                  {COLORS.map((col) => (
                    <button
                      key={col}
                      aria-label={`Colour ${col}`}
                      className={`swatch ${c.styles.background.type === 'color' && c.styles.background.color === col ? 'active' : ''}`}
                      style={{ background: col }}
                      onClick={() =>
                        edit((cfg) => {
                          cfg.styles.background.type = 'color';
                          cfg.styles.background.color = col;
                        })
                      }
                    />
                  ))}
                  <label className="swatch swatch-picker" aria-label="Custom colour">
                    <input
                      type="color"
                      value={c.styles.background.color}
                      onChange={(e) =>
                        edit((cfg) => {
                          cfg.styles.background.type = 'color';
                          cfg.styles.background.color = e.target.value;
                        }, false)
                      }
                    />
                  </label>
                </div>
                <h3>Frame</h3>
                <Row label="Padding">
                  <Slider label="Padding" min={0} max={0.3} step={0.01} value={c.output.paddingRatio01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v, f) => edit((cfg) => (cfg.output.paddingRatio01 = v), f)} />
                </Row>
                <Row label="Roundness">
                  <Slider label="Roundness" min={0} max={48} step={1} value={c.styles.screenBorderRadius} format={(v) => `${v}`} onChange={(v, f) => edit((cfg) => (cfg.styles.screenBorderRadius = v), f)} />
                </Row>
                <Row label="Shadow">
                  <Slider label="Shadow" min={0} max={1} step={0.05} value={c.styles.shadow.intensity} format={(v) => `${Math.round(v * 100)}%`} onChange={(v, f) => edit((cfg) => (cfg.styles.shadow.intensity = v), f)} />
                </Row>
              </>
            )}

            {tab === 'cursor' && (
              <>
                <h3>Cursor</h3>
                <Row label="Show cursor">
                  <Switch label="Show cursor" checked={!c.cursor.hide} onChange={(v) => edit((cfg) => (cfg.cursor.hide = !v))} />
                </Row>
                <Row label="Size">
                  <Slider label="Cursor size" min={16} max={128} step={1} value={c.cursor.size} format={(v) => `${v}`} onChange={(v, f) => edit((cfg) => (cfg.cursor.size = v), f)} />
                </Row>
                <Row label="Smoothing">
                  <Segmented
                    label="Cursor smoothing"
                    value={presetOf(CURSOR_SMOOTHING, c.animations.mouseMovementSpring)?.value ?? 'default'}
                    options={CURSOR_SMOOTHING.map((p) => ({ value: p.value, label: p.label }))}
                    onChange={(v) => {
                      const spring = CURSOR_SMOOTHING.find((p) => p.value === v)!.spring;
                      edit((cfg) => (cfg.animations.mouseMovementSpring = spring ? { ...spring } : null));
                    }}
                  />
                </Row>
                <Row label="Tilt" hint="Leans with movement">
                  <Switch label="Tilt" checked={c.cursor.rotationMode !== 'none'} onChange={(v) => edit((cfg) => (cfg.cursor.rotationMode = v ? 'velocity' : 'none'))} />
                </Row>
                <Row label="Click highlight">
                  <Switch label="Click highlight" checked={c.cursor.clickEffect?.type === 'circle'} onChange={(v) => edit((cfg) => (cfg.cursor.clickEffect = v ? { type: 'circle' } : null))} />
                </Row>
                <Row label="Hide when idle" hint="After 2 seconds">
                  <Switch label="Hide when idle" checked={c.cursor.hideNotMovingAfterMs !== null} onChange={(v) => edit((cfg) => (cfg.cursor.hideNotMovingAfterMs = v ? 2000 : null))} />
                </Row>
              </>
            )}

            {tab === 'motion' && (
              <>
                <h3>Camera</h3>
                <Row label="Movement">
                  <Segmented
                    label="Screen movement"
                    value={presetOf(SCREEN_MOVEMENT, c.animations.screenMovementSpring)?.value ?? 'default'}
                    options={SCREEN_MOVEMENT.map((p) => ({ value: p.value, label: p.label }))}
                    onChange={(v) => edit((cfg) => (cfg.animations.screenMovementSpring = { ...SCREEN_MOVEMENT.find((p) => p.value === v)!.spring }))}
                  />
                </Row>
                <Row label="Motion blur">
                  <Slider label="Motion blur" min={0} max={1} step={0.05} value={c.animations.motionBlurAmount} format={(v) => `${Math.round(v * 100)}%`} onChange={(v, f) => edit((cfg) => (cfg.animations.motionBlurAmount = v), f)} />
                </Row>
                <Row label="Anticipate zooms" hint="Start 350 ms early">
                  <Switch label="Anticipate zooms" checked={c.zooms.startAnimationEarly} onChange={(v) => edit((cfg) => (cfg.zooms.startAnimationEarly = v))} />
                </Row>
                <h3>Zooms</h3>
                <p className="muted">Zooms are created from your clicks. Select one on the timeline to change it, or press <kbd className="kbd">Z</kbd> to add one at the playhead.</p>
                <Button variant="ghost" icon={<RestoreIcon />} onClick={() => editor.restoreAutoZooms()}>
                  Restore automatic zooms
                </Button>
              </>
            )}

            {tab === 'audio' && (
              <>
                <h3>Audio</h3>
                <Row label="Microphone">
                  <Switch label="Microphone" checked={!c.audio.muteMicrophone} onChange={(v) => edit((cfg) => (cfg.audio.muteMicrophone = !v))} />
                </Row>
                <Row label="System audio">
                  <Switch label="System audio" checked={!c.audio.muteSystemAudio} onChange={(v) => edit((cfg) => (cfg.audio.muteSystemAudio = !v))} />
                </Row>
                <Row label="Volume">
                  <Slider label="Volume" min={0} max={2} step={0.05} value={c.audio.volume} format={(v) => `${Math.round(v * 100)}%`} onChange={(v, f) => edit((cfg) => (cfg.audio.volume = v), f)} />
                </Row>
              </>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function ZoomPanel({ editor, zoom, onDone }: { editor: EditorController; zoom: Zoom; onDone: () => void }) {
  return (
    <div className="panel">
      <div className="panel-header">
        <ZoomIcon size={18} />
        <h3>Zoom</h3>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
      <Row label="Level">
        <Slider label="Zoom level" min={1} max={4} step={0.1} value={zoom.zoom} format={(v) => `${v.toFixed(1)}×`} onChange={(v) => editor.updateZoom(zoom.id, { zoom: v })} />
      </Row>
      <Row label="Follow">
        <Segmented
          label="Zoom target"
          value={zoom.type}
          options={[
            { value: 'follow-click-groups', label: 'Cursor' },
            { value: 'manual', label: 'Fixed point' },
          ]}
          onChange={(v) => editor.updateZoom(zoom.id, { type: v })}
        />
      </Row>
      {zoom.type === 'manual' && <p className="muted">Click the preview to choose where this zoom points.</p>}
      <Row label="Instant cut" hint="No animation in or out">
        <Switch label="Instant cut" checked={zoom.hasInstantAnimation} onChange={(v) => editor.updateZoom(zoom.id, { hasInstantAnimation: v })} />
      </Row>
      <Row label="Enabled">
        <Switch label="Enabled" checked={!zoom.isDisabled} onChange={(v) => editor.updateZoom(zoom.id, { isDisabled: !v })} />
      </Row>
      <div className="panel-footer">
        <Button
          variant="danger"
          icon={<TrashIcon />}
          onClick={() => {
            editor.deleteZoom(zoom.id);
            onDone();
          }}
        >
          Delete zoom
        </Button>
      </div>
    </div>
  );
}
