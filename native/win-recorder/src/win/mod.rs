//! Windows recording session: capture, input, cursor, then write the bundle on stop.

mod clock;
mod cursor;
mod input;
mod state;

use crate::bundle::{self, DisplayInfo, SessionTimes, VIDEO_FILE};
use crate::{Args, emit};
use std::io::BufRead;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromPoint};
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
use windows::Win32::UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForMonitor, MDT_EFFECTIVE_DPI, SetProcessDpiAwarenessContext};
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder, VideoSettingsSubType};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl};
use windows_capture::monitor::Monitor;
use windows_capture::settings::{ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings};

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Everything the capture callback needs; shared with the main thread so the encoder can be
/// finished after the capture thread stops (frames only arrive when the screen changes).
#[derive(Clone)]
struct CaptureShared {
    encoder: Arc<Mutex<Option<VideoEncoder>>>,
    first_frame_ticks: Arc<Mutex<Option<i64>>>,
    frames: Arc<std::sync::atomic::AtomicU64>,
}

struct Capture {
    shared: CaptureShared,
}

impl GraphicsCaptureApiHandler for Capture {
    type Flags = CaptureShared;
    type Error = BoxError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self { shared: ctx.flags })
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame, _control: InternalCaptureControl) -> Result<(), Self::Error> {
        let ticks = frame.timestamp()?.Duration;
        if let Ok(mut first) = self.shared.first_frame_ticks.lock() {
            first.get_or_insert(ticks);
        }
        if let Ok(mut enc) = self.shared.encoder.lock() {
            if let Some(e) = enc.as_mut() {
                e.send_frame(frame)?;
            }
        }
        self.shared.frames.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

struct MonitorGeometry {
    left: i32,
    top: i32,
    width: u32,
    height: u32,
    scale: f64,
    refresh: u32,
}

fn monitor_geometry(m: &Monitor) -> Result<MonitorGeometry, String> {
    let h = HMONITOR(m.as_raw_hmonitor());
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if !unsafe { GetMonitorInfoW(h, &mut info) }.as_bool() {
        return Err("Could not read the monitor size".into());
    }
    let (mut dx, mut dy) = (96u32, 96u32);
    unsafe { GetDpiForMonitor(h, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) }.map_err(|e| format!("GetDpiForMonitor: {e}"))?;
    let r = info.rcMonitor;
    Ok(MonitorGeometry {
        left: r.left,
        top: r.top,
        width: (r.right - r.left) as u32,
        height: (r.bottom - r.top) as u32,
        scale: dx as f64 / 96.0,
        refresh: m.refresh_rate().unwrap_or(60),
    })
}

fn even(v: u32) -> u32 {
    v & !1
}

pub fn record(args: &Args) -> Result<(), String> {
    // Hook and monitor coordinates in physical pixels on every monitor.
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    clock::init();
    let out = &args.out;
    let cursor_dir = out.join("cursors");
    std::fs::create_dir_all(&cursor_dir).map_err(|e| format!("Cannot create {}: {e}", cursor_dir.display()))?;

    let monitor = match args.at {
        Some((x, y)) => Monitor::from_raw_hmonitor(unsafe { MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST) }.0),
        None => Monitor::from_index(args.monitor + 1).map_err(|e| format!("Monitor {} not found: {e}", args.monitor + 1))?,
    };
    let geo = monitor_geometry(&monitor)?;

    // Excluding the cursor needs Windows 10 2004+. Hiding the yellow capture border needs a newer
    // build; where it is missing we record with the border rather than fail.
    if !GraphicsCaptureApi::is_cursor_settings_supported().unwrap_or(false) {
        return Err("This Windows version cannot record without the system cursor. Windows 10 version 2004 or newer is required.".into());
    }
    let border = if GraphicsCaptureApi::is_border_settings_supported().unwrap_or(false) {
        DrawBorderSettings::WithoutBorder
    } else {
        emit("log", serde_json::json!({ "message": "Capture border cannot be hidden on this Windows version" }));
        DrawBorderSettings::Default
    };

    state::init(state::Shared {
        monitor: state::Monitor { left_px: geo.left, top_px: geo.top, scale: geo.scale },
        moves: Mutex::new(Vec::new()),
        clicks: Mutex::new(Vec::new()),
        keys: Mutex::new(Vec::new()),
        cursors: Mutex::new(Vec::new()),
        cursor_id: Mutex::new("arrow".into()),
        keys_down: Mutex::new(Default::default()),
        buttons_down: Default::default(),
        stopping: Default::default(),
        cursor_dir,
    });

    let (w, h) = (even(geo.width), even(geo.height));
    // About 0.1 bit per pixel per frame at 60 fps keeps text crisp (4K ~ 50 Mbit/s).
    let bitrate = ((w as f64 * h as f64 * 60.0 * 0.1) as u32).clamp(8_000_000, 80_000_000);
    // H.264 (decodable everywhere) up to its 4096x2304 limit; HEVC for larger monitors.
    let codec = if w > 4096 || h > 2304 { VideoSettingsSubType::HEVC } else { VideoSettingsSubType::H264 };
    let encoder = VideoEncoder::new(
        VideoSettingsBuilder::new(w, h).sub_type(codec).frame_rate(60).bitrate(bitrate),
        AudioSettingsBuilder::default().disabled(true),
        ContainerSettingsBuilder::default(),
        out.join(VIDEO_FILE),
    )
    .map_err(|e| format!("Video encoder: {e}"))?;

    let shared = CaptureShared { encoder: Arc::new(Mutex::new(Some(encoder))), first_frame_ticks: Arc::new(Mutex::new(None)), frames: Default::default() };
    let input = input::start()?;
    let cursor = cursor::start();

    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::WithoutCursor,
        border,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        shared.clone(),
    );
    let control = Capture::start_free_threaded(settings).map_err(|e| format!("Screen capture failed to start: {e}"))?;

    // The session starts at the first captured frame.
    let waited = Instant::now();
    let first_ticks = loop {
        if let Some(t) = *shared.first_frame_ticks.lock().map_err(|e| e.to_string())? {
            break t;
        }
        if waited.elapsed() > Duration::from_secs(5) {
            return Err("No frames from the screen capture within 5 seconds".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let start_ms = clock::system_relative_to_ms(first_ticks);
    // Where the pointer is when recording starts (in points), and its shape.
    let initial_pos = {
        let mut p = POINT::default();
        unsafe { GetCursorPos(&mut p) }.ok().map(|_| state::get().to_points(p.x, p.y))
    };
    let initial_cursor = state::get().current_cursor();
    let unix_start = clock::unix_ms() - (clock::now_ms() - start_ms);
    emit("started", serde_json::json!({ "unixStartMs": unix_start }));

    // Wait for "stop" (or the app closing our stdin).
    for line in std::io::stdin().lock().lines() {
        match line {
            Ok(l) if l.trim() == "stop" => break,
            Ok(_) => continue,
            Err(_) => break,
        }
    }
    let end_ms = clock::now_ms();
    let unix_end = clock::unix_ms();

    control.stop().map_err(|e| format!("Stopping capture: {e}"))?;
    let s = state::get();
    s.stopping.store(true, Ordering::Relaxed);
    input.stop();
    cursor.join();
    if let Some(enc) = shared.encoder.lock().map_err(|e| e.to_string())?.take() {
        enc.finish().map_err(|e| format!("Finishing video: {e}"))?;
    }

    let within = |t: f64| t >= start_ms && t <= end_ms;
    let mut moves: Vec<_> = s.moves.lock().map_err(|e| e.to_string())?.iter().filter(|e| within(e.process_time_ms)).cloned().collect();
    // The editor draws the cursor from the first event on, so pin the pointer's position at the
    // very start (otherwise it is invisible until the mouse first moves).
    if let (Some((x, y)), true) = (initial_pos, moves.first().is_none_or(|m| m.process_time_ms > start_ms)) {
        moves.insert(0, bundle::MouseRecord {
            kind: "mouseMoved",
            x,
            y,
            cursor_id: initial_cursor.clone(),
            process_time_ms: start_ms,
            unix_time_ms: unix_start,
            active_modifiers: vec![],
            button: None,
        });
    }
    let clicks: Vec<_> = s.clicks.lock().map_err(|e| e.to_string())?.iter().filter(|e| within(e.process_time_ms)).cloned().collect();
    let keys: Vec<_> = s.keys.lock().map_err(|e| e.to_string())?.iter().filter(|e| within(e.process_time_ms)).cloned().collect();
    let cursors = s.cursors.lock().map_err(|e| e.to_string())?.clone();
    bundle::write_events(out, &moves, &clicks, &keys, &cursors).map_err(|e| format!("Writing events: {e}"))?;
    bundle::write_metadata(
        out,
        &SessionTimes { process_time_start_ms: start_ms, process_time_end_ms: end_ms, unix_start_ms: unix_start, unix_end_ms: unix_end },
        &DisplayInfo { width_pt: w as f64 / geo.scale, height_pt: h as f64 / geo.scale, recording_scale: 1.0 / geo.scale, refresh_rate: geo.refresh },
    )
    .map_err(|e| format!("Writing metadata: {e}"))?;
    emit("stopped", serde_json::json!({ "frames": shared.frames.load(Ordering::Relaxed), "moves": moves.len(), "clicks": clicks.len() }));
    Ok(())
}
