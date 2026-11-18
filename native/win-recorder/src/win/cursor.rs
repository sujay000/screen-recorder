//! Cursor shape tracking: polls the system cursor every 8 ms, names standard cursors with the same
//! ids the editor knows (arrow, iBeam, pointingHand, ...), saves every new shape as a PNG with its
//! hotspot, and records a synthetic move when the shape changes (like the reference recorder).
//!
//! The same poll also records pointer moves the low-level mouse hook never sees: SetCursorPos,
//! remote-desktop and some tablet input move the pointer without a hook event.

use super::{clock, state};
use crate::bundle::{CursorRecord, MouseRecord, Point, Size};
use sha1::{Digest, Sha1};
use std::sync::atomic::Ordering;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, DeleteObject, GetDC, GetDIBits, GetObjectW, HBITMAP, HGDIOBJ, ReleaseDC};
use windows::Win32::UI::WindowsAndMessaging::{
    CURSOR_SHOWING, CURSORINFO, GetCursorInfo, GetIconInfo, HCURSOR, HICON, ICONINFO, IDC_APPSTARTING, IDC_ARROW, IDC_CROSS, IDC_HAND, IDC_HELP, IDC_IBEAM, IDC_NO, IDC_SIZEALL,
    IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE, IDC_SIZEWE, IDC_UPARROW, IDC_WAIT, LoadCursorW,
};
use windows::core::PCWSTR;

const POLL: Duration = Duration::from_millis(8);

fn standard_cursors() -> Vec<(isize, &'static str)> {
    let table: [(PCWSTR, &str); 15] = [
        (IDC_ARROW, "arrow"),
        (IDC_IBEAM, "iBeam"),
        (IDC_HAND, "pointingHand"),
        (IDC_CROSS, "crosshair"),
        (IDC_SIZEWE, "resizeLeftRight"),
        (IDC_SIZENS, "resizeUpDown"),
        (IDC_SIZENWSE, "windowResizeNorthWestSouthEast"),
        (IDC_SIZENESW, "windowResizeNorthEastSouthWest"),
        (IDC_SIZEALL, "openHand"),
        (IDC_NO, "operationNotAllowed"),
        (IDC_WAIT, "wait"),
        (IDC_APPSTARTING, "appStarting"),
        (IDC_HELP, "help"),
        (IDC_UPARROW, "upArrow"),
        (IDC_ARROW, "arrow"),
    ];
    table
        .iter()
        .filter_map(|(idc, name)| unsafe { LoadCursorW(None, *idc).ok().map(|h| (h.0 as isize, *name)) })
        .collect()
}

struct CursorImage {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
    hotspot: (u32, u32),
}

unsafe fn bitmap_bits(hbm: HBITMAP) -> Option<(u32, u32, Vec<u8>)> {
    let mut bm = BITMAP::default();
    if unsafe { GetObjectW(HGDIOBJ(hbm.0), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _)) } == 0 {
        return None;
    }
    let (w, h) = (bm.bmWidth as u32, bm.bmHeight as u32);
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w as i32,
            biHeight: -(h as i32), // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let dc = unsafe { GetDC(None) };
    let lines = unsafe { GetDIBits(dc, hbm, 0, h, Some(buf.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS) };
    unsafe { ReleaseDC(None, dc) };
    if lines == 0 { None } else { Some((w, h, buf)) }
}

// Colour cursors carry BGRA (sometimes with an all-zero alpha, then the AND mask is the alpha).
// Monochrome cursors have only a double-height mask: top half AND, bottom half XOR.
unsafe fn read_cursor(h: HCURSOR) -> Option<CursorImage> {
    let mut ii = ICONINFO::default();
    unsafe { GetIconInfo(HICON(h.0), &mut ii).ok()? };
    let mask = unsafe { bitmap_bits(ii.hbmMask) };
    let color = if ii.hbmColor.is_invalid() { None } else { unsafe { bitmap_bits(ii.hbmColor) } };
    unsafe {
        let _ = DeleteObject(HGDIOBJ(ii.hbmMask.0));
        if !ii.hbmColor.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(ii.hbmColor.0));
        }
    }
    let hotspot = (ii.xHotspot, ii.yHotspot);
    match (color, mask) {
        (Some((w, hgt, bgra)), m) => {
            let has_alpha = bgra.chunks(4).any(|p| p[3] != 0);
            let mut rgba = Vec::with_capacity(bgra.len());
            for (i, p) in bgra.chunks(4).enumerate() {
                let a = if has_alpha {
                    p[3]
                } else {
                    // AND bit 0 means opaque.
                    m.as_ref().map(|(_, _, mb)| if mb[i * 4] == 0 { 255 } else { 0 }).unwrap_or(255)
                };
                rgba.extend_from_slice(&[p[2], p[1], p[0], a]);
            }
            Some(CursorImage { width: w, height: hgt, rgba, hotspot })
        }
        (None, Some((w, h2, mb))) => {
            let hgt = h2 / 2;
            let mut rgba = Vec::with_capacity((w * hgt * 4) as usize);
            for i in 0..(w * hgt) as usize {
                let and = mb[i * 4] != 0;
                let xor = mb[(i + (w * hgt) as usize) * 4] != 0;
                let px = match (and, xor) {
                    (false, false) => [0, 0, 0, 255],
                    (false, true) => [255, 255, 255, 255],
                    (true, false) => [0, 0, 0, 0],
                    (true, true) => [0, 0, 0, 255], // "invert" pixels, drawn as black
                };
                rgba.extend_from_slice(&px);
            }
            Some(CursorImage { width: w, height: hgt, rgba, hotspot })
        }
        _ => None,
    }
}

fn save_png(path: &std::path::Path, img: &CursorImage) -> std::io::Result<()> {
    let file = std::fs::File::create(path)?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), img.width, img.height);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut w = enc.write_header().map_err(std::io::Error::other)?;
    w.write_image_data(&img.rgba).map_err(std::io::Error::other)
}

pub struct CursorThread {
    handle: JoinHandle<()>,
}

pub fn start() -> CursorThread {
    let handle = thread::spawn(|| {
        let s = state::get();
        let standard = standard_cursors();
        let mut last: isize = 0;
        let mut seen: std::collections::HashMap<isize, String> = Default::default();
        // Events default to "arrow" until the first shape is seen, so the arrow image must always
        // be in the bundle. (Windows reports no visible cursor when no mouse is attached.)
        if let Some((raw, _)) = standard.iter().find(|(_, n)| *n == "arrow") {
            let id = register_cursor(*raw, HCURSOR(*raw as *mut _), &standard);
            seen.insert(*raw, id);
        }
        let mut last_pos: Option<(i32, i32)> = None;
        while !s.stopping.load(Ordering::Relaxed) {
            let mut ci = CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, ..Default::default() };
            let ok = unsafe { GetCursorInfo(&mut ci).is_ok() };
            if ok {
                record_unhooked_move(ci.ptScreenPos, &mut last_pos);
            }
            if ok && (ci.flags.0 & CURSOR_SHOWING.0) != 0 && !ci.hCursor.is_invalid() && ci.hCursor.0 as isize != last {
                let raw = ci.hCursor.0 as isize;
                last = raw;
                let id = match seen.get(&raw) {
                    Some(id) => id.clone(),
                    None => {
                        let id = register_cursor(raw, ci.hCursor, &standard);
                        seen.insert(raw, id.clone());
                        id
                    }
                };
                if let Ok(mut cur) = s.cursor_id.lock() {
                    *cur = id;
                }
                // The shape changed between moves: record where the pointer is with the new shape.
                let POINT { x, y } = ci.ptScreenPos;
                let (px, py) = s.to_points(x, y);
                let kind = if s.buttons_down.load(Ordering::Relaxed) != 0 { "mouseDragged" } else { "mouseMoved" };
                if let Ok(mut m) = s.moves.lock() {
                    m.push(MouseRecord {
                        kind,
                        x: px,
                        y: py,
                        cursor_id: s.current_cursor(),
                        process_time_ms: clock::now_ms(),
                        unix_time_ms: clock::unix_ms(),
                        active_modifiers: vec![],
                        button: None,
                    });
                }
            }
            thread::sleep(POLL);
        }
    });
    CursorThread { handle }
}

// Adds a move if the pointer is somewhere the last recorded move (from the hook or from here) is
// not. Hook moves arrive at the same positions, so with a real mouse this adds almost nothing.
fn record_unhooked_move(pos: POINT, last_pos: &mut Option<(i32, i32)>) {
    let s = state::get();
    let here = (pos.x, pos.y);
    if *last_pos == Some(here) {
        return;
    }
    *last_pos = Some(here);
    let (px, py) = s.to_points(pos.x, pos.y);
    let Ok(mut m) = s.moves.lock() else { return };
    if m.last().is_some_and(|l| (l.x - px).abs() < 0.01 && (l.y - py).abs() < 0.01) {
        return;
    }
    let kind = if s.buttons_down.load(Ordering::Relaxed) != 0 { "mouseDragged" } else { "mouseMoved" };
    m.push(MouseRecord {
        kind,
        x: px,
        y: py,
        cursor_id: s.current_cursor(),
        process_time_ms: clock::now_ms(),
        unix_time_ms: clock::unix_ms(),
        active_modifiers: vec![],
        button: None,
    });
}

fn register_cursor(raw: isize, h: HCURSOR, standard: &[(isize, &'static str)]) -> String {
    let s = state::get();
    let named = standard.iter().find(|(hh, _)| *hh == raw).map(|(_, n)| (*n).to_string());
    let Some(img) = (unsafe { read_cursor(h) }) else {
        return named.unwrap_or_else(|| "arrow".into());
    };
    let id = named.clone().unwrap_or_else(|| {
        let mut hasher = Sha1::new();
        hasher.update(&img.rgba);
        hasher.update(img.hotspot.0.to_le_bytes());
        hasher.update(img.hotspot.1.to_le_bytes());
        format!("custom-{:x}", hasher.finalize())
    });
    let mut known = match s.cursors.lock() {
        Ok(k) => k,
        Err(_) => return id,
    };
    if known.iter().any(|c| c.id == id) {
        return id;
    }
    let _ = save_png(&s.cursor_dir.join(format!("{id}.png")), &img);
    let scale = s.monitor.scale;
    known.push(CursorRecord {
        id: id.clone(),
        hot_spot: Point { x: img.hotspot.0 as f64 / scale, y: img.hotspot.1 as f64 / scale },
        standard_size: Size { width: img.width as f64 / scale, height: img.height as f64 / scale },
        system_cursor: named.is_some(),
    });
    id
}

impl CursorThread {
    pub fn join(self) {
        let _ = self.handle.join();
    }
}
