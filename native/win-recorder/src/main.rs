//! Windows recorder helper.
//!
//! Records one monitor with Windows.Graphics.Capture (system cursor excluded, no border), plus
//! global mouse/keyboard events and the cursor shape, and writes a recording bundle that the
//! editor opens (layout in docs/ARCHITECTURE.md, same as the reference recorder).
//!
//! Protocol with the app: `recorder record --out <dir> [--at <x>,<y> | --monitor <index>]`; one JSON object per
//! line on stdout (`{"event":"started"|"stopped"|"error"|"log", ...}`); "stop" on stdin ends the
//! recording.

mod bundle;

#[cfg(windows)]
mod win;

use std::path::PathBuf;

pub enum Command {
    Record,
    SelfCheck,
}

pub struct Args {
    pub command: Command,
    pub out: PathBuf,
    pub monitor: usize,
    /// A physical screen point inside the monitor to record; preferred over the index because
    /// the app's display order is not guaranteed to match the system's enumeration order.
    pub at: Option<(i32, i32)>,
}

fn parse_args() -> Result<Args, String> {
    let mut it = std::env::args().skip(1);
    let command = match it.next().as_deref() {
        Some("record") => Command::Record,
        Some("self-check") => Command::SelfCheck,
        _ => return Err("usage: recorder record --out <dir> [--at <x>,<y> | --monitor <index>] | recorder self-check --out <dir>".into()),
    };
    let mut out = None;
    let mut monitor = 0usize;
    let mut at = None;
    while let Some(a) = it.next() {
        match a.as_str() {
            "--out" => out = it.next().map(PathBuf::from),
            "--monitor" => monitor = it.next().and_then(|v| v.parse().ok()).ok_or("--monitor needs a number")?,
            "--at" => {
                let v = it.next().ok_or("--at needs x,y")?;
                let (x, y) = v.split_once(',').ok_or("--at needs x,y")?;
                at = Some((x.trim().parse().map_err(|_| "bad --at x")?, y.trim().parse().map_err(|_| "bad --at y")?));
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(Args { command, out: out.ok_or("--out is required")?, monitor, at })
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
        let result = match args.command {
            Command::Record => win::record(&args),
            Command::SelfCheck => win::selfcheck::run(&args.out),
        };
        if let Err(e) = result {
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
