//! Windows recorder helper.
//!
//! Records one monitor with Windows.Graphics.Capture (system cursor excluded, no border), plus
//! global mouse/keyboard events and the cursor shape, and writes a recording bundle that the
//! editor opens (layout in docs/ARCHITECTURE.md, same as the reference recorder).
//!
//! Protocol with the app: `recorder record --out <dir> --monitor <index>`; one JSON object per
//! line on stdout (`{"event":"started"|"stopped"|"error"|"log", ...}`); "stop" on stdin ends the
//! recording.

mod bundle;

#[cfg(windows)]
mod win;

use std::path::PathBuf;

pub struct Args {
    pub out: PathBuf,
    pub monitor: usize,
}

fn parse_args() -> Result<Args, String> {
    let mut it = std::env::args().skip(1);
    match it.next().as_deref() {
        Some("record") => {}
        _ => return Err("usage: recorder record --out <dir> [--monitor <index>]".into()),
    }
    let mut out = None;
    let mut monitor = 0usize;
    while let Some(a) = it.next() {
        match a.as_str() {
            "--out" => out = it.next().map(PathBuf::from),
            "--monitor" => monitor = it.next().and_then(|v| v.parse().ok()).ok_or("--monitor needs a number")?,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(Args { out: out.ok_or("--out is required")?, monitor })
}

pub fn emit(event: &str, extra: serde_json::Value) {
    let mut obj = serde_json::json!({ "event": event });
    if let (Some(o), Some(e)) = (obj.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            o.insert(k.clone(), v.clone());
        }
    }
    println!("{obj}");
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            emit("error", serde_json::json!({ "message": e }));
            std::process::exit(2);
        }
    };
    #[cfg(windows)]
    {
        if let Err(e) = win::record(&args) {
            emit("error", serde_json::json!({ "message": e }));
            std::process::exit(1);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = args;
        emit("error", serde_json::json!({ "message": "This recorder only runs on Windows." }));
        std::process::exit(1);
    }
}
