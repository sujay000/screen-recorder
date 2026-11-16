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
