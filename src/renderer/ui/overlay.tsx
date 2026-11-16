// Dialog and toast notifications.

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

// ---- Toasts ----

export interface Toast {
  id: number;
  title: string;
  description?: string;
  tone: 'default' | 'success' | 'error';
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(title: string, opts: { description?: string; tone?: Toast['tone']; durationMs?: number } = {}): void {
  const t: Toast = { id: nextId++, title, description: opts.description, tone: opts.tone ?? 'default' };
  toasts = [...toasts, t].slice(-4);
  emit();
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    emit();
  }, opts.durationMs ?? (t.tone === 'error' ? 7000 : 3500));
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
          <div className="toast-title">{t.title}</div>
          {t.description && <div className="toast-desc">{t.description}</div>}
        </div>
      ))}
    </div>
  );
}
