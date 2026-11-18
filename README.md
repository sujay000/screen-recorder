# Recorder

A personal screen recorder for Windows (the editor also runs on macOS) that makes recordings
look polished automatically: zooms that follow your clicks, a smoothed cursor that lands exactly
on what you click, motion blur, rounded corners, shadow and a background. Motion and framing are
re-implemented from verified specs of Screen Studio 4.1.0 (see `~/screen-recorder-research/verified`).

## Use it (Windows)

1. Unzip `Recorder-<version>-win.zip` and run `Recorder.exe`.
2. Pick a display, choose microphone / system audio, press **Start recording**.
3. Press the red timer button to stop. The recording opens in the editor.
4. Adjust zooms and clips on the timeline, style in the right panel, then **Export** to MP4 or GIF.

What the editor does: automatic zooms that follow your clicks (or a glass **loupe** magnifier
instead, per zoom), a smoothed cursor that lands on what you click, click effects, motion blur,
backgrounds (gradient, mesh, colour, blurred image), aspect ratio presets, a webcam bubble,
trim / cut / speed per clip, and keyboard shortcut keycaps.

If recording fails, run the native helper's self-check from a terminal in the unzipped folder:
`resources\native\recorder.exe self-check --out %TEMP%\rc-check`. It tests monitor/DPI lookup, input
hooks, cursor capture and file writing in about 2 seconds and prints a JSON report.

Recordings are saved in `Videos\Recorder\*.recording`. Screen Studio projects (`.screenstudio`)
open in the editor too.

Shortcuts: `Space` play/pause · `S` split the clip at the playhead · `Z` add a zoom at the playhead ·
`Delete` remove the selected zoom or cut the selected clip · `←/→` step a frame (`Shift` for a
second) · `Esc` deselect.

## Develop

Requirements: Node 22, Rust (stable) with the `x86_64-pc-windows-gnu` target and MinGW (`brew
install mingw-w64`) to cross-compile the Windows recorder from macOS/Linux.

```sh
npm install
npm test              # unit tests (core logic, checked against reference recordings when present)
npm run typecheck
npm run dev           # build and run the editor
npm run dist:win      # build recorder.exe + package release/Recorder-<version>-win.zip
```

In-app checks (real Electron, real GPU):

```sh
scripts/selftest.sh <bundle> out.mp4 [fps] [height]   # open + export, prints timings
scripts/screenshot.sh <bundle|""> out.png              # screenshot of the editor / welcome screen
node scripts/validate-bundle.mjs <bundle>               # bundle completeness and consistency
```

CI: `.github/workflows/windows.yml` runs on `windows-latest`: unit tests, builds the recorder,
makes a scripted recording (mouse moves, clicks, a drag, typing), validates it, exports it in
the app and packages the zip. Push the repo to GitHub to run it.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.
