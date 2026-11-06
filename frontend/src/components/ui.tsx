import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, MoreHorizontal, X } from 'lucide-react';
import type { LabelColor, Status, StatusState } from '../types';
import { STATE_LABEL, liveState, timeText, dateTime } from '../lib/format';
import { useApp } from '../lib/appContext';

/** A dialog on <body>: Escape or its close button closes it; clicking the backdrop does nothing. */
export function Modal({ title, onClose, children, footer, wide = false, size }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; size?: 'xl' }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal="true">
      <div className={`flex max-h-[90vh] w-full ${size === 'xl' ? 'max-w-5xl' : wide ? 'max-w-3xl' : 'max-w-lg'} flex-col rounded-xl border border-border bg-surface shadow-pop ci-scale-in`}>
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-semibold text-heading">{title}</h2>
          <button onClick={onClose} className="btn-ghost -mr-2" aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

const STATE_STYLE: Record<StatusState, { chip: string; dot: string }> = {
  active: { chip: 'bg-success-bg text-success border-success-border', dot: 'bg-success' },
  expiring: { chip: 'bg-warning-bg text-warning border-warning-border', dot: 'bg-warning pulse-dot' },
  expired: { chip: 'bg-danger-bg text-danger border-danger-border', dot: 'bg-danger' },
  error: { chip: 'bg-surface text-danger border-danger', dot: 'bg-danger' },
  'signed-out': { chip: 'bg-surface-alt text-muted border-border', dot: 'bg-faint' },
  unknown: { chip: 'bg-surface-alt text-muted border-border', dot: 'bg-faint' },
  'long-lived': { chip: 'bg-primary-soft text-primary-soft-text border-border', dot: 'bg-primary' },
};

/** Status with a live countdown: "● Active · ~3h 12m left". */
export function StatusChip({ status, compact = false }: { status: Status; compact?: boolean }) {
  const { now, state: app } = useApp();
  const state = liveState(status, now, app.settings.warnMinutes);
  const style = STATE_STYLE[state];
  const time = timeText(status, state, now);
  const title = [
    status.expiresAt ? `${status.estimated ? 'Expected to end' : 'Ends'} ${dateTime(status.expiresAt)}` : null,
    status.estimated ? 'Estimated: AWS does not report this end time, so the app works it out.' : null,
    status.note ?? null,
  ].filter(Boolean).join('\n');
  return (
    <span title={title || undefined} className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[0.6875rem] font-semibold ${style.chip}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {STATE_LABEL[state]}
      {time && !compact && <span className="font-medium opacity-80">· {time}</span>}
    </span>
  );
}

export const LABEL_COLORS: LabelColor[] = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];

export function labelStyle(color: LabelColor | null) {
  return color ? { color: `var(--env-${color}-on)`, background: `var(--env-${color})` } : undefined;
}

/** An account's label: a solid badge in its color (status chips are soft pills, so the two don't mix up). */
export function LabelTag({ label, color, placeholder = 'Add label' }: { label: string; color: LabelColor | null; placeholder?: string }) {
  if (!label) {
    return <span className="inline-flex items-center rounded border border-dashed border-border-strong px-1.5 py-0.5 text-[0.625rem] font-semibold text-faint">{placeholder}</span>;
  }
  return (
    <span style={labelStyle(color)} className={`inline-flex items-center rounded px-1.5 py-0.5 text-[0.625rem] font-bold uppercase tracking-wide ${color ? '' : 'bg-surface-alt text-muted'}`}>
      {label}
    </span>
  );
}

/** The color swatches; `onChange(null)` clears the color. */
export function ColorSwatches({ value, onChange, size = 'h-6 w-6' }: { value: LabelColor | null; onChange: (c: LabelColor | null) => void; size?: string }) {
  const ring = 'ring-2 ring-focus ring-offset-2 ring-offset-surface';
  return (
    <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Color">
      {LABEL_COLORS.map(c => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          title={c}
          onClick={() => onChange(c)}
          style={{ background: `var(--env-${c})` }}
          className={`${size} rounded-full transition-transform hover:scale-110 ${value === c ? ring : ''}`}
        />
      ))}
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        title="No color"
        onClick={() => onChange(null)}
        className={`${size} rounded-full border border-dashed border-border-strong text-[0.625rem] text-faint ${value === null ? ring : ''}`}
      >
        ∅
      </button>
    </div>
  );
}

/**
 * A small panel under its trigger, closed by clicking outside or Escape.
 * `children` gets `close`, so the panel can close itself after a choice.
 */
export function Popover({ trigger, children, align = 'left', title, width = 'w-72' }: { trigger: ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; title?: string; width?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative inline-block">
      <button type="button" title={title} onClick={() => setOpen(o => !o)} className="rounded text-left transition-opacity hover:opacity-80" aria-expanded={open}>
        {trigger}
      </button>
      {open && (
        <div className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-full z-40 mt-1.5 ${width} rounded-lg border border-border bg-surface p-3 text-left shadow-pop ci-scale-in`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function CopyButton({ text, label, className = 'btn', title }: { text: string; label?: string; className?: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard blocked: nothing to do
    }
  };
  return (
    <button type="button" onClick={() => void copy()} className={className} title={title ?? `Copy: ${text}`}>
      {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
      {label && <span>{copied ? 'Copied' : label}</span>}
    </button>
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** A small dropdown. Items with `danger` are red. */
export function Menu({ items, trigger, align = 'right' }: { items: MenuItem[]; trigger?: ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(o => !o)} className={trigger ? 'btn' : 'btn-ghost'} aria-haspopup="menu" aria-expanded={open}>
        {trigger ?? <MoreHorizontal size={15} />}
      </button>
      {open && (
        <div role="menu" className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-full z-40 mt-1 min-w-[200px] rounded-lg border border-border bg-surface p-1 shadow-pop ci-scale-in`}>
          {items.map(item => (
            <button
              key={item.label}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors disabled:opacity-40 ${item.danger ? 'text-danger hover:bg-danger-bg' : 'text-text hover:bg-surface-alt'}`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Any "which project?" field. */
export function ProjectSelect({ value, onChange, id }: { value: string; onChange: (id: string) => void; id?: string }) {
  const { state } = useApp();
  return (
    <select id={id} value={value} onChange={e => onChange(e.target.value)} className="field">
      <option value="" disabled>
        Pick a project…
      </option>
      {state.projects.map(p => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="mt-2 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger">{children}</p>;
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted">{children}</p>;
}

export function Toasts() {
  const { toasts } = useApp();
  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-80 flex-col gap-2">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`pointer-events-auto rounded-lg border px-3.5 py-2.5 text-xs shadow-pop ci-fade-in ${
            t.tone === 'error' ? 'border-danger-border bg-danger-bg text-danger' : t.tone === 'info' ? 'border-border bg-surface text-text' : 'border-success-border bg-success-bg text-success'
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>,
    document.body,
  );
}
