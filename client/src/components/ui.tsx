import { Check, ChevronLeft, ChevronRight, LoaderCircle, Minus, Plus, TriangleAlert, X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { PageMeta } from '@rb/shared';
import { cx } from '../utils/format';

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function SidePanel({
  title,
  subtitle,
  aside,
  onClose,
  children,
  footer,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  aside?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.overlay') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside className={cx('side-panel', className)} aria-label={typeof title === 'string' ? title : undefined}>
      <div className="side-panel-header">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 className="side-panel-title">{title}</h2>
          {subtitle && <div className="side-panel-subtitle">{subtitle}</div>}
        </div>
        {aside}
        <button className="icon-btn close-red" onClick={onClose} aria-label="Close panel" title="Close">
          <X />
        </button>
      </div>
      <div className="side-panel-body">{children}</div>
      {footer && <div className="side-panel-footer">{footer}</div>}
    </aside>
  );
}

export function Modal({ title, children, onClose, width }: { title: ReactNode; children: ReactNode; onClose: () => void; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    // Keep a field the content focused itself (autoFocus), and never pull focus on a re-render.
    if (!ref.current?.contains(document.activeElement)) ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not(.modal-close)')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" ref={ref} style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <div className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <button type="button" className="icon-btn close-red modal-close" onClick={onClose} aria-label="Close" title="Close">
            <X />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      {danger ? (
        <div className="alert alert-danger">
          <TriangleAlert />
          <span>{message}</span>
        </div>
      ) : (
        <div className="muted">{message}</div>
      )}
      <div className="modal-actions">
        <CancelButton onClick={onCancel} disabled={busy} label="No" />
        <ConfirmButton onClick={onConfirm} busy={busy} label={confirmLabel} />
      </div>
    </Modal>
  );
}

/** Red "✗ Cancel" – used for every cancel/back-out action so the colour always means "no". */
export function CancelButton({ onClick, disabled, label = 'Cancel', className }: { onClick: () => void; disabled?: boolean; label?: string; className?: string }) {
  return (
    <button type="button" className={cx('btn btn-cancel', className)} onClick={onClick} disabled={disabled}>
      <X /> {label}
    </button>
  );
}

/** Green "✓ …" – the positive answer next to a CancelButton. */
export function ConfirmButton({
  onClick,
  busy,
  disabled,
  label,
  type = 'button',
  className,
}: {
  onClick?: () => void;
  busy?: boolean;
  disabled?: boolean;
  label: ReactNode;
  type?: 'button' | 'submit';
  className?: string;
}) {
  return (
    <button type={type} className={cx('btn btn-primary', className)} onClick={onClick} disabled={busy || disabled}>
      {busy ? <Spinner /> : <Check />} {label}
    </button>
  );
}

/** A restaurant's uploaded logo, or its initials – never a built-in logo. */
export function LogoMark({ src, name, className }: { src?: string | null; name: string; className?: string }) {
  if (src) return <img className={className} src={src} alt="" />;
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <span className={cx('logo-mark', className)} aria-hidden="true">
      {initials || '?'}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cx('spinner', className)} aria-label="Loading" />;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children && <div>{children}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="empty">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cx('field', className)}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

export function Stepper({ value, min = 1, max = 30, onChange, label }: { value: number; min?: number; max?: number; onChange: (n: number) => void; label: string }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label={`Decrease ${label}`}>
        <Minus />
      </button>
      <output aria-live="polite">{value}</output>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label={`Increase ${label}`}>
        <Plus />
      </button>
    </div>
  );
}

export function Pagination({ meta, onPage }: { meta: PageMeta; onPage: (p: number) => void }) {
  const { page, totalPages, total, limit } = meta;
  const start = total === 0 ? 0 : (page - 1) * limit + 1;
  const end = Math.min(total, page * limit);
  const pages: number[] = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(totalPages, page + 2); p++) pages.push(p);
  return (
    <div className="pagination">
      <span>
        Showing {start}–{end} of {total}
      </span>
      <div className="pages">
        <button className="page-btn" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page">
          <ChevronLeft size={16} />
        </button>
        {pages.map((p) => (
          <button key={p} className={cx('page-btn', p === page && 'active')} onClick={() => onPage(p)}>
            {p}
          </button>
        ))}
        <button className="page-btn" onClick={() => onPage(page + 1)} disabled={page >= totalPages} aria-label="Next page">
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
