//! Recording bundle files: event records and metadata.json, in the same shape the editor's
//! loader reads (src/core/project/loader.ts).

use serde::Serialize;
use std::fs;
use std::io;
use std::path::Path;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MouseRecord {
    #[serde(rename = "type")]
    pub kind: &'static str, // mouseMoved | mouseDragged | mouseDown | mouseUp
    pub x: f64,              // points, relative to the recorded monitor
    pub y: f64,
    pub cursor_id: String,
    pub process_time_ms: f64,
    pub unix_time_ms: f64,
    pub active_modifiers: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub button: Option<&'static str>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KeyRecord {
    #[serde(rename = "type")]
    pub kind: &'static str, // keyDown | keyUp
    pub key_code: u32,
    pub is_a_repeat: bool,
    pub process_time_ms: f64,
    pub unix_time_ms: f64,
    pub active_modifiers: Vec<&'static str>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CursorRecord {
    pub id: String,
    pub hot_spot: Point,
    pub standard_size: Size,
    pub system_cursor: bool,
}

#[derive(Serialize, Clone, Copy)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Clone, Copy)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

pub struct SessionTimes {
    pub process_time_start_ms: f64,
    pub process_time_end_ms: f64,
    pub unix_start_ms: f64,
    pub unix_end_ms: f64,
}

pub struct DisplayInfo {
    pub width_pt: f64,
    pub height_pt: f64,
    pub recording_scale: f64, // points per pixel
    pub refresh_rate: u32,
}

pub const VIDEO_FILE: &str = "channel-1-display-0.mp4";
const MOVES_FILE: &str = "mousemoves-0.json";
const CLICKS_FILE: &str = "mouseclicks-0.json";
const KEYS_FILE: &str = "keystrokes-0.json";

pub fn write_json<T: Serialize>(dir: &Path, name: &str, value: &T) -> io::Result<()> {
    let text = serde_json::to_string(value).map_err(io::Error::other)?;
    fs::write(dir.join(name), text)
}

pub fn write_events(dir: &Path, moves: &[MouseRecord], clicks: &[MouseRecord], keys: &[KeyRecord], cursors: &[CursorRecord]) -> io::Result<()> {
    write_json(dir, MOVES_FILE, &moves)?;
    write_json(dir, CLICKS_FILE, &clicks)?;
    write_json(dir, KEYS_FILE, &keys)?;
    write_json(dir, "cursors.json", &cursors)
}

pub fn write_metadata(dir: &Path, t: &SessionTimes, d: &DisplayInfo) -> io::Result<()> {
    let duration = t.process_time_end_ms - t.process_time_start_ms;
    let session = serde_json::json!({
        "durationMs": duration,
        "processTimeStartMs": t.process_time_start_ms,
        "processTimeEndMs": t.process_time_end_ms,
        "unixStartMs": t.unix_start_ms,
        "unixEndMs": t.unix_end_ms,
    });
    let meta = serde_json::json!({
        "polyrecorderVersion": format!("recorder-win {}", env!("CARGO_PKG_VERSION")),
        "recorders": [
            { "id": "channel-0-cursor", "type": "cursor", "cursorImagesFolder": "cursors", "cursorsInfoFile": "cursors.json", "configuration": {} },
            { "id": "channel-0-input", "type": "input", "configuration": { "captureKeyStrokes": true }, "sessions": [{
                "durationMs": duration,
                "processTimeStartMs": t.process_time_start_ms,
                "processTimeEndMs": t.process_time_end_ms,
                "unixStartMs": t.unix_start_ms,
                "unixEndMs": t.unix_end_ms,
                "mouseMovesFilename": MOVES_FILE,
                "mouseClicksFilename": CLICKS_FILE,
                "keyStrokesFilename": KEYS_FILE,
            }]},
            { "id": "channel-1-display", "type": "display", "configuration": {}, "sessions": [{
                "bounds": { "x": 0, "y": 0, "width": d.width_pt, "height": d.height_pt },
                "displayRefreshRate": d.refresh_rate,
                "durationMs": duration,
                "outputFilename": VIDEO_FILE,
                "processTimeStartMs": t.process_time_start_ms,
                "processTimeEndMs": t.process_time_end_ms,
                "recordingScale": d.recording_scale,
                "unixStartMs": t.unix_start_ms,
                "unixEndMs": t.unix_end_ms,
            }]},
        ],
        "sessions": [session],
        "state": "complete",
    });
    let text = serde_json::to_string_pretty(&meta).map_err(io::Error::other)?;
    fs::write(dir.join("metadata.json"), text)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Writes a small bundle with the real writer so the editor's loader can be tested against it
    // (tests/core/recorder-contract.test.ts reads native/win-recorder/target/contract-bundle).
    #[test]
    fn writes_contract_bundle() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/contract-bundle/recording");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("cursors")).unwrap();
        let mv = |t: f64, x: f64, y: f64| MouseRecord { kind: "mouseMoved", x, y, cursor_id: "arrow".into(), process_time_ms: t, unix_time_ms: 1_700_000_000_000.0 + t, active_modifiers: vec![], button: None };
        let moves = vec![mv(1010.0, 100.0, 100.0), mv(1500.0, 400.0, 300.0), mv(2600.0, 800.0, 500.0)];
        let click = |kind: &'static str, t: f64| MouseRecord { kind, x: 400.0, y: 300.0, cursor_id: "arrow".into(), process_time_ms: t, unix_time_ms: 0.0, active_modifiers: vec!["shift"], button: Some("left") };
        let clicks = vec![click("mouseDown", 1600.0), click("mouseUp", 1680.0)];
        let keys = vec![KeyRecord { kind: "keyDown", key_code: 72, is_a_repeat: false, process_time_ms: 2000.0, unix_time_ms: 0.0, active_modifiers: vec![] }];
        let cursors = vec![CursorRecord { id: "arrow".into(), hot_spot: Point { x: 0.0, y: 0.0 }, standard_size: Size { width: 32.0, height: 32.0 }, system_cursor: true }];
        write_events(&dir, &moves, &clicks, &keys, &cursors).unwrap();
        write_metadata(
            &dir,
            &SessionTimes { process_time_start_ms: 1000.0, process_time_end_ms: 9000.0, unix_start_ms: 1_700_000_001_000.0, unix_end_ms: 1_700_000_009_000.0 },
            &DisplayInfo { width_pt: 1280.0, height_pt: 720.0, recording_scale: 0.5, refresh_rate: 60 },
        )
        .unwrap();
        let meta: serde_json::Value = serde_json::from_str(&fs::read_to_string(dir.join("metadata.json")).unwrap()).unwrap();
        assert_eq!(meta["sessions"][0]["processTimeStartMs"], 1000.0);
    }
}
