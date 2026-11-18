// Dialog and toast notifications. Errors stay until dismissed and show the full detail (with a
// copy button): this app is used by its developer, so exact causes beat friendly vagueness.

import { type ReactNode, useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

export function Dialog({ open, onClose, title, children, dismissible = true }: { open: boolean; onClose: () => void; title: string; children: ReactNode; dismissible?: boolean }) {
  useEffect(() => {
    if (!open || !dismissible) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, dismissible, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="dialog-backdrop" onPointerDown={(e) => dismissible && e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal aria-label={title}>
        <h2 className="dialog-title">{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ---- Errors ----

// Turns anything thrown into readable text. Electron wraps IPC errors as
// "Error invoking remote method 'x': Error: <message>"; keep the channel, drop the noise.
export function describeError(err: unknown): { message: string; detail: string } {
  const e = err instanceof Error ? err : new Error(String(err));
  let message = e.message;
  const ipc = /^Error invoking remote method '([^']+)': (?:\w*Error: )?([\s\S]*)$/.exec(message);
  if (ipc) message = `${ipc[2]} (in ${ipc[1]})`;
  const detail = [e.name && e.name !== 'Error' ? `${e.name}: ${message}` : message, e.stack?.split('\n').slice(1).join('\n')].filter(Boolean).join('\n');
  return { message, detail };
}

// ---- Toasts ----

export interface Toast {
  id: number;
  title: string;
  description?: string;
  detail?: string; // full text for errors (stack, codes); copyable
  tone: 'default' | 'success' | 'error';
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function dismissToast(id: number): void {
  toasts = toasts.filter((x) => x.id !== id);
  emit();
}

// Returns the toast id (for dismissToast). durationMs: Infinity keeps it until dismissed.
export function toast(title: string, opts: { description?: string; detail?: string; tone?: Toast['tone']; durationMs?: number } = {}): number {
  const t: Toast = { id: nextId++, title, description: opts.description, detail: opts.detail, tone: opts.tone ?? 'default' };
  toasts = [...toasts, t].slice(-5);
  emit();
  // Errors stay until dismissed.
  const duration = opts.durationMs ?? 3500;
  if (t.tone !== 'error' && Number.isFinite(duration)) setTimeout(() => dismissToast(t.id), duration);
  return t.id;
}

export function toastError(title: string, err: unknown): void {
  const { message, detail } = describeError(err);
  console.error(title, err);
  toast(title, { tone: 'error', description: message, detail });
}

export function Toaster() {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toasts,
  );
  return (
    <div className="toaster" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          <div className="toast-head">
            <div className="toast-title">{t.title}</div>
            {t.tone === 'error' && (
              <div className="toast-actions">
                <button onClick={() => void navigator.clipboard.writeText([t.title, t.description, t.detail].filter(Boolean).join('\n'))}>Copy</button>
                <button onClick={() => dismissToast(t.id)} aria-label="Dismiss">
                  ✕
                </button>
              </div>
            )}
          </div>
          {t.description && <div className="toast-desc">{t.description}</div>}
          {t.detail && (
            <details className="toast-detail">
              <summary>Details</summary>
              <pre>{t.detail}</pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
