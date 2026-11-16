//! One timebase for every track: milliseconds since this process started, from the
//! QueryPerformanceCounter clock. Windows.Graphics.Capture frame times (SystemRelativeTime) use
//! the same clock in 100 ns units, so video and input line up exactly.

use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

struct Base {
    freq: f64,
    start_ms: f64, // QPC at startup, in ms
}

static BASE: OnceLock<Base> = OnceLock::new();

fn qpc() -> i64 {
    let mut v = 0i64;
    // Cannot fail on Windows XP or later.
    unsafe { QueryPerformanceCounter(&mut v).ok() };
    v
}

fn base() -> &'static Base {
    BASE.get_or_init(|| {
        let mut f = 0i64;
        unsafe { QueryPerformanceFrequency(&mut f).ok() };
        let freq = f as f64;
        Base { freq, start_ms: qpc() as f64 * 1000.0 / freq }
    })
}

pub fn init() {
    base();
}

/// Milliseconds since process start.
pub fn now_ms() -> f64 {
    let b = base();
    qpc() as f64 * 1000.0 / b.freq - b.start_ms
}

/// Converts a SystemRelativeTime (100 ns ticks of the QPC clock) to process milliseconds.
pub fn system_relative_to_ms(ticks_100ns: i64) -> f64 {
    ticks_100ns as f64 / 10_000.0 - base().start_ms
}

pub fn unix_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}
