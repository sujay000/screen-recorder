# Recorder

A personal screen recorder for **Windows** that makes recordings look polished automatically,
in the style of Screen Studio. It gives you zooms that follow your clicks, a smoothed cursor that
lands exactly on what you click, motion blur, rounded corners, a shadow and a background. The
editor also runs on macOS, where it opens Screen Studio projects.

Features:
- automatic zooms (or a glass loupe magnifier, per zoom)
- cursor smoothing, tilt and click effects
- backgrounds: gradient, mesh, colour, blurred image
- aspect ratio presets (16:9, 9:16, 1:1, 4:3)
- webcam bubble
- trim, cut and speed per clip
- keyboard shortcut keycaps
- export to MP4 or GIF

---

## For Windows users: install and use

### Requirements

- Windows 10 (version 2004 or later) or Windows 11, 64-bit.
- A GPU with up-to-date drivers. The editor uses WebGPU; machines without a usable GPU fall
  back to software rendering, which is slow.

### Install

1. Get `Recorder-<version>-win.zip`. Either build it (see below), or download the
   `recorder-windows` artifact from the repository's **Actions** tab (the `windows` workflow
   builds it on every push).
2. Right-click the zip → **Extract All…** to a folder of your choice, for example
   `C:\Apps\Recorder`. Do not run it from inside the zip.
3. Run `Recorder.exe`. The app is not code-signed, so Windows SmartScreen may say *"Windows
   protected your PC"*. Click **More info → Run anyway**.

### Record

1. Pick the display to record.
2. Turn **Microphone**, **System audio** and **Webcam** on or off. Windows asks for microphone
   and camera access the first time. If it does not, allow them in *Settings → Privacy &
   security → Microphone / Camera* for desktop apps.
3. Press **Start recording**. The app window hides itself from the recording.
4. Press the red timer button to stop. The recording opens in the editor.

Recordings are saved in `Videos\Recorder\<name>.recording` (one folder per recording).

### Edit and export

- **Timeline**: zooms are created from your clicks. Drag a zoom to move it, drag its edges to
  resize, click it to change its level, target or style (Screen / Loupe).
- **Clips**: press `S` to split at the playhead. Drag a clip's edges to trim it. Select a clip
  to change its speed or cut it.
- **Right panel**: background, padding, roundness, shadow, camera (Style tab); cursor and
  keyboard shortcuts (Cursor tab); animation (Motion tab); audio (Audio tab).
- **Export** (top right): MP4 (720p to 4K, 30 or 60 fps, with audio) or GIF (360p to 720p).

Keyboard: `Space` play/pause · `S` split clip · `Z` add zoom · `Delete` remove the selected zoom or
cut the selected clip · `←/→` step a frame (`Shift` for one second) · `Esc` deselect.

### If something goes wrong

- **Recording does not start**: open a terminal in the extracted folder and run
  `resources\native\recorder.exe self-check --out %TEMP%\rc-check`. In about 2 seconds it
  tests monitor/DPI lookup, input hooks, cursor capture and file writing, and prints a JSON
  report.
- **Logs**: `%APPDATA%\Recorder\logs\main.log` (app) and `recording\recorder.log` inside
  each `.recording` folder (native recorder).
- **"Cannot decode the screen video" (HEVC)**: very large displays (above 4096×2304) are
  recorded in HEVC. Install *HEVC Video Extensions* from the Microsoft Store.
- Error messages in the app have **Copy** and **Details** buttons. Paste them into an issue.

---

## Build from source on Windows

1. Install:
   - [Node.js 22](https://nodejs.org) (LTS, includes npm)
   - [Rust](https://rustup.rs). Use the default `x86_64-pc-windows-msvc` toolchain; the
     installer offers the Visual Studio C++ Build Tools it needs.
   - [Git](https://git-scm.com)
2. In PowerShell:

   ```powershell
   git clone <this repository URL> screen-recorder
   cd screen-recorder
   npm ci
   npm run dist:win:native
   ```

3. The app is at `release\Recorder-<version>-win.zip` (unpacked copy in `release\win-unpacked`).

Other commands:

```powershell
npm test                      # unit tests
npm run typecheck
npm run build:recorder:native # only the native recorder -> native\bin\recorder.exe
npm run dev                   # build and run the editor without packaging
```

`npm run dev` on Windows records only if `native\bin\recorder.exe` exists, so run
`npm run build:recorder:native` first.

## Build from macOS or Linux (cross-compile)

Requirements: Node 22, Rust with the `x86_64-pc-windows-gnu` target (`rustup target add
x86_64-pc-windows-gnu`) and MinGW (`brew install mingw-w64` / `apt install mingw-w64`).

```sh
npm ci
npm run dist:win      # cross-compiles recorder.exe and packages release/Recorder-<version>-win.zip
npm run dev           # run the editor (opens recordings and Screen Studio projects; recording is Windows-only)
```

## Checks

```sh
npm test
scripts/selftest.sh <bundle> out.mp4 [fps] [height]   # open + export in the real app, prints timings
scripts/screenshot.sh <bundle|""> out.png [seekMs]     # screenshot of the editor / welcome screen
node scripts/validate-bundle.mjs <bundle>               # recording bundle completeness
```

CI: `.github/workflows/windows.yml` runs on `windows-latest`:
1. builds and tests the native recorder;
2. runs the unit tests;
3. makes a scripted recording (mouse moves, clicks, a drag, typing), validates it and exports it
   in the app;
4. uploads the packaged zip as an artifact.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together and the known
differences from Screen Studio.
