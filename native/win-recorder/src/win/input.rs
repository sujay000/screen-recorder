//! Global mouse and keyboard capture with low-level hooks on a dedicated message-loop thread.
//! Injected input (for example from automated tests) is recorded like real input.

use super::{clock, state};
use crate::bundle::{KeyRecord, MouseRecord};
use std::sync::atomic::Ordering;
use std::thread::{self, JoinHandle};
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::Foundation::HINSTANCE;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, PostThreadMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
    WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEMOVE, WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP,
    WM_SYSKEYDOWN, WM_SYSKEYUP,
};

fn modifiers() -> Vec<&'static str> {
    let down = |vk: u16| unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 };
    let mut m = Vec::new();
    if down(VK_SHIFT.0) {
        m.push("shift");
    }
    if down(VK_CONTROL.0) {
        m.push("control");
    }
    if down(VK_MENU.0) {
        m.push("alt");
    }
    if down(VK_LWIN.0) || down(VK_RWIN.0) {
        m.push("meta");
    }
    m
}

fn mouse_record(kind: &'static str, x: i32, y: i32, button: Option<&'static str>) -> MouseRecord {
    let s = state::get();
    let (px, py) = s.to_points(x, y);
    MouseRecord {
        kind,
        x: px,
        y: py,
        cursor_id: s.current_cursor(),
        process_time_ms: clock::now_ms(),
        unix_time_ms: clock::unix_ms(),
        active_modifiers: modifiers(),
        button,
    }
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        let s = state::get();
        let (x, y) = (info.pt.x, info.pt.y);
        let msg = wparam.0 as u32;
        let click = |kind: &'static str, button: &'static str, bit: u32, down: bool| {
            if down {
                s.buttons_down.fetch_or(bit, Ordering::Relaxed);
            } else {
                s.buttons_down.fetch_and(!bit, Ordering::Relaxed);
            }
            if let Ok(mut c) = s.clicks.lock() {
                c.push(mouse_record(kind, x, y, Some(button)));
            }
        };
        match msg {
            WM_MOUSEMOVE => {
                let kind = if s.buttons_down.load(Ordering::Relaxed) != 0 { "mouseDragged" } else { "mouseMoved" };
                if let Ok(mut m) = s.moves.lock() {
                    m.push(mouse_record(kind, x, y, None));
                }
            }
            WM_LBUTTONDOWN => click("mouseDown", "left", 1, true),
            WM_LBUTTONUP => click("mouseUp", "left", 1, false),
            WM_RBUTTONDOWN => click("mouseDown", "right", 2, true),
            WM_RBUTTONUP => click("mouseUp", "right", 2, false),
            WM_MBUTTONDOWN => click("mouseDown", "middle", 4, true),
            WM_MBUTTONUP => click("mouseUp", "middle", 4, false),
            _ => {}
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let s = state::get();
        let msg = wparam.0 as u32;
        let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
        let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
        if down || up {
            let repeat = match s.keys_down.lock() {
                Ok(mut set) => {
                    if down {
                        !set.insert(info.vkCode)
                    } else {
                        set.remove(&info.vkCode);
                        false
                    }
                }
                Err(_) => false,
            };
            if let Ok(mut k) = s.keys.lock() {
                k.push(KeyRecord {
                    kind: if down { "keyDown" } else { "keyUp" },
                    key_code: info.vkCode,
                    is_a_repeat: repeat,
                    process_time_ms: clock::now_ms(),
                    unix_time_ms: clock::unix_ms(),
                    active_modifiers: modifiers(),
                });
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

pub struct InputThread {
    thread_id: u32,
    handle: JoinHandle<()>,
}

pub fn start() -> Result<InputThread, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<u32, String>>();
    let handle = thread::spawn(move || unsafe {
        // Global low-level hooks need the module that contains the hook procedures.
        let module = GetModuleHandleW(None).ok().map(|m| HINSTANCE(m.0));
        let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), module, 0);
        let keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), module, 0);
        let (mouse, keyboard) = match (mouse, keyboard) {
            (Ok(m), Ok(k)) => (m, k),
            (m, k) => {
                let _ = tx.send(Err(format!("Could not install input hooks: {:?} {:?}", m.err(), k.err())));
                return;
            }
        };
        let _ = tx.send(Ok(GetCurrentThreadId()));
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let _ = UnhookWindowsHookEx(mouse);
        let _ = UnhookWindowsHookEx(keyboard);
    });
    let thread_id = rx.recv().map_err(|e| e.to_string())??;
    Ok(InputThread { thread_id, handle })
}

impl InputThread {
    pub fn stop(self) {
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        let _ = self.handle.join();
    }
}
