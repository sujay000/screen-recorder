//! State shared by the input hooks, the cursor poller and the recorder. Hook procedures are
//! plain `extern "system"` functions without a context pointer, so this lives in a global.

use crate::bundle::{CursorRecord, KeyRecord, MouseRecord};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU32};
use std::sync::{Mutex, OnceLock};

pub struct Monitor {
    pub left_px: i32,
    pub top_px: i32,
    pub scale: f64, // physical pixels per point (DPI / 96)
}

pub struct Shared {
    pub monitor: Monitor,
    pub moves: Mutex<Vec<MouseRecord>>,
    pub clicks: Mutex<Vec<MouseRecord>>,
    pub keys: Mutex<Vec<KeyRecord>>,
    pub cursors: Mutex<Vec<CursorRecord>>,
    pub cursor_id: Mutex<String>,
    pub keys_down: Mutex<HashSet<u32>>,
    pub buttons_down: AtomicU32, // bit mask: 1 left, 2 right, 4 middle
    pub stopping: AtomicBool,
    pub cursor_dir: std::path::PathBuf,
}

static SHARED: OnceLock<Shared> = OnceLock::new();

pub fn init(s: Shared) {
    let _ = SHARED.set(s);
}

pub fn get() -> &'static Shared {
    SHARED.get().expect("recorder state not initialised")
}

impl Shared {
    /// Physical screen pixels to points relative to the recorded monitor.
    pub fn to_points(&self, x: i32, y: i32) -> (f64, f64) {
        ((x - self.monitor.left_px) as f64 / self.monitor.scale, (y - self.monitor.top_px) as f64 / self.monitor.scale)
    }

    pub fn current_cursor(&self) -> String {
        self.cursor_id.lock().map(|c| c.clone()).unwrap_or_else(|_| "arrow".into())
    }
}
