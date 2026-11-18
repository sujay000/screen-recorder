//! `recorder self-check --out <dir>`: exercises every Win32 path except the screen capture itself
//! (monitor/DPI lookup, input hooks with synthetic input, cursor capture and PNG save, bundle
//! writing) and prints a JSON report. Runs on real Windows and under Wine.

use super::{clock, cursor, input, monitor_geometry, state};
use crate::bundle::{self, DisplayInfo, SessionTimes};
use crate::emit;
use std::sync::Mutex;
use std::sync::atomic::Ordering;
use std::time::Duration;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEINPUT, SendInput, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;
use windows_capture::monitor::Monitor;

fn send(inputs: &[INPUT]) {
    unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
}

fn mouse(flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dwFlags: flags, ..Default::default() } } }
}

fn key(vk: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() }, ..Default::default() } },
    }
}

pub fn run(out: &std::path::Path) -> Result<(), String> {
    clock::init();
    let cursor_dir = out.join("cursors");
    std::fs::create_dir_all(&cursor_dir).map_err(|e| format!("Cannot create {}: {e}", cursor_dir.display()))?;
    let monitor = Monitor::primary().map_err(|e| format!("Primary monitor: {e}"))?;
    let geo = monitor_geometry(&monitor)?;
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
    let start = clock::now_ms();
    let input = input::start()?;
    let cursor = cursor::start();
    std::thread::sleep(Duration::from_millis(200));

    // Synthetic input: a glide, two clicks, a short word.
    for i in 0..30 {
        unsafe {
            let _ = SetCursorPos(geo.left + 100 + i * 10, geo.top + 100 + i * 5);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    for _ in 0..2 {
        send(&[mouse(MOUSEEVENTF_LEFTDOWN)]);
        std::thread::sleep(Duration::from_millis(50));
        send(&[mouse(MOUSEEVENTF_LEFTUP)]);
        std::thread::sleep(Duration::from_millis(150));
    }
    for vk in [0x48u16, 0x49] {
        send(&[key(vk, false)]);
        std::thread::sleep(Duration::from_millis(30));
        send(&[key(vk, true)]);
    }
    std::thread::sleep(Duration::from_millis(300));

    let end = clock::now_ms();
    let s = state::get();
    s.stopping.store(true, Ordering::Relaxed);
    input.stop();
    cursor.join();

    let moves = s.moves.lock().map_err(|e| e.to_string())?.clone();
    let clicks = s.clicks.lock().map_err(|e| e.to_string())?.clone();
    let keys = s.keys.lock().map_err(|e| e.to_string())?.clone();
    let cursors = s.cursors.lock().map_err(|e| e.to_string())?.clone();
    bundle::write_events(out, &moves, &clicks, &keys, &cursors).map_err(|e| format!("Writing events: {e}"))?;
    bundle::write_metadata(
        out,
        &SessionTimes { process_time_start_ms: start, process_time_end_ms: end, unix_start_ms: clock::unix_ms() - (end - start), unix_end_ms: clock::unix_ms() },
        &DisplayInfo { width_pt: geo.width as f64 / geo.scale, height_pt: geo.height as f64 / geo.scale, recording_scale: 1.0 / geo.scale, refresh_rate: geo.refresh },
    )
    .map_err(|e| format!("Writing metadata: {e}"))?;
    let pngs = std::fs::read_dir(&s.cursor_dir).map(|d| d.count()).unwrap_or(0);
    emit(
        "selfcheck",
        serde_json::json!({
            "monitor": { "left": geo.left, "top": geo.top, "width": geo.width, "height": geo.height, "scale": geo.scale, "refresh": geo.refresh },
            "moves": moves.len(), "clicks": clicks.len(), "keys": keys.len(),
            "cursorShapes": cursors.iter().map(|c| c.id.clone()).collect::<Vec<_>>(), "cursorPngs": pngs,
            "firstMove": moves.first().map(|m| [m.x, m.y]),
            "lastMove": moves.last().map(|m| [m.x, m.y]),
            "clickKinds": clicks.iter().map(|c| c.kind).collect::<Vec<_>>(),
            "captureSupported": { "cursorExclusion": windows_capture::graphics_capture_api::GraphicsCaptureApi::is_cursor_settings_supported().ok(), "borderToggle": windows_capture::graphics_capture_api::GraphicsCaptureApi::is_border_settings_supported().ok() },
        }),
    );
    Ok(())
}
