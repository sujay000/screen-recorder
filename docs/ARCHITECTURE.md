# Architecture

```
native/win-recorder (Rust)          src/main (Electron main)            src/renderer (page)
  screen  ─ Windows.Graphics.Capture   spawns recorder.exe, media://       React UI
  input   ─ low-level hooks            protocol, file dialogs, export      Player / Exporter
  cursor  ─ GetCursorInfo + PNGs       file writes                          WebGPU compositor
  → recording bundle on disk  ───────────────────────────────────────────▶ src/core (pure TS)
                                                                            motion + layout math
```

## Folders

| Path | What lives there |
|---|---|
| `src/core/geometry` | `Rect` with the reference's fit/cover/zoom/contain semantics; binary searches |
| `src/core/animation` | Spring integrator (1 ms steps, clamp, settle time, last-substep quirk); deterministic frame timeline |
| `src/core/project` | Data model, bundle loader (sessions → recording time), slice time map |
| `src/core/camera` | Auto-zoom generation from clicks, movement groups the camera follows, stage layout and webcam avoidance |
| `src/core/cursor` | Cursor model: shake filter, 10 s chunked path planner (look-ahead + speed boosts so the cursor lands on clicks), tilt, press, idle/typing hide |
| `src/core/scene` | Per-frame targets for every animated value, and conversion to GPU inputs |
| `src/node` | Node-only: open/save bundles, add audio tracks |
| `src/main` | Electron main process |
| `src/preload` | The typed `window.recorder` bridge (contract in `src/shared/ipc.ts`) |
| `src/renderer/gpu` | WebGPU compositor and its single WGSL pass |
| `src/renderer/media` | Video demux/decode (mp4box + WebCodecs), cursor images, audio decode/mix/encode |
| `src/renderer/editor` | Editor controller (no UI framework) + React views |
| `src/renderer/export` | MP4 export (WebCodecs H.264/AAC + mp4-muxer) and its dialog |
| `src/renderer/ui` | Small UI primitives: buttons, switch, slider, segmented, dialog, toasts, icons |
| `native/win-recorder` | Windows recorder helper |
| `tests` | Vitest suites; `tests/fixtures/reference.ts` finds Screen Studio projects for parity tests |
| `scripts` | Build, in-app self-test, screenshot, bundle validator, CI script |

## Recording bundle

```
<name>.recording/
  recording/
    metadata.json          recorders (cursor, input, display, microphone, systemAudio) + sessions
    channel-1-display-0.mp4  screen video, H.264, system cursor NOT drawn, first frame = session start
    mousemoves-0.json      {type, x, y (points, monitor-relative), cursorId, processTimeMs, ...}
    mouseclicks-0.json     mouseDown / mouseUp with button
    keystrokes-0.json      keyDown / keyUp
    cursors.json, cursors/<id>.png   every cursor shape seen, hotspot + size in points
    microphone-0.webm, system-audio-0.webm   recorded by the page, start time in metadata
    webcam-0.mp4           recorded by the page with MediaRecorder as H.264 MP4 (mp4box demuxes it)
  recorder-project.json    editor state: config, zooms, slices
```

All times share one clock (`processTimeMs`, QPC-based on Windows). The loader converts to
recording time: `processTimeMs − session.processTimeStartMs + session.recordingStartMs`.

## A frame, end to end

1. `Scene.targetAt(t)` computes targets: screen rect from the active zoom's movement group (or
   the resting focus), cursor position from the planned path, opacity/press/rotation targets,
   background zoom growth.
2. `StyleTimeline` applies springs frame by frame on a fixed grid (preview 60 fps, export at the
   export fps, one continuous simulation from frame 0).
3. `buildFrameInputs` turns the style of this and the previous frame into GPU numbers (motion-blur
   trail, corner radius, shadow light, cursor quad).
4. `Compositor.render` draws background → shadow → screen → click effect → cursor in one pass in
   gamma-2 premultiplied space, then dithers. With a glass loupe on screen it also draws the scene
   magnified about the lens centre and combines both in `loupe.wgsl` (refraction, colour fringe,
   rim reflection, shine, shadow).

## Known differences from the reference

- Motion blur samples the trail (16 taps on export) instead of the analytic quadratic integral.
- Corners are circular rounded rects, not Figma-smoothed squircles.
- Hover detection (`core/cursor/hover-detector.ts`) matches the reference on the two sample
  recordings (Area: identical; 100 s test: 4 of 5 identical, 1 a frame earlier). Repeat
  suppression within 120 ms is inferred from those results, not read from the binary.
- Loupe zooms: the rim blur reads one 9-tap ring instead of mip levels, and the magnified view
  includes the background instead of a separately frosted backdrop (only visible where the lens
  leaves the screen).
- Webcam: only the camera-overlay layout (bubble in a corner). Split-screen, cutout and
  fullscreen-camera layouts, face tracking, grain and LUTs are not implemented. The bubble is
  drawn above the loupe in its own blended pass.
