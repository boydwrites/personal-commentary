import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, X } from "lucide-react";
import { navigate } from "../api";

export function Link({ to, children, className, onClick, ...rest }: { to: string; children: ReactNode; className?: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={to}
      className={className}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

// ---- Toasts: one global status region. A toast can carry one action (Undo, Open…). ----
type ToastAction = { label: string; run: () => void };
type Toast = { id: number; text: string; kind: "info" | "error"; action?: ToastAction };
type Push = (text: string, kind?: Toast["kind"] | { kind?: Toast["kind"]; action?: ToastAction }) => void;
const ToastCtx = createContext<Push>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback<Push>((text, opt) => {
    const o = typeof opt === "string" || opt === undefined ? { kind: opt } : opt;
    const kind = o.kind ?? "info";
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, kind, action: o.action }]);
    setTimeout(() => dismiss(id), kind === "error" ? 8000 : o.action ? 7000 : 3200);
  }, [dismiss]);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span className="grow">{t.text}</span>
            {t.action && (
              <button
                className="toast-action"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            {t.kind === "error" && (
              <button className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                <X className="lucide" />
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---- Focus-trapped overlays ----
function useFocusTrap(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select, [tabindex]:not([tabindex="-1"])') ?? []);
    setTimeout(() => (el?.querySelector<HTMLElement>("[data-autofocus]") ?? el)?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === "Tab") {
        const f = focusables();
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [open]);
  return ref;
}

export function Modal({ open, onClose, children, label, wide }: { open: boolean; onClose: () => void; children: ReactNode; label: string; wide?: boolean }) {
  const ref = useFocusTrap(open, onClose);
  if (!open) return null;
  return createPortal(
    <>
      <div className="overlay" onClick={onClose} />
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={label} ref={ref} tabIndex={-1}>
        <button className="icon-btn modal-close" onClick={onClose} aria-label="Close">
          <X className="lucide" />
        </button>
        {children}
      </div>
    </>,
    document.body,
  );
}

export function Drawer({ open, onClose, children, label }: { open: boolean; onClose: () => void; children: ReactNode; label: string }) {
  const ref = useFocusTrap(open, onClose);
  if (!open) return null;
  return createPortal(
    <>
      <div className="overlay light" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={label} ref={ref} tabIndex={-1}>
        {children}
      </aside>
    </>,
    document.body,
  );
}

/** A small popover menu behind a ⋯ button. Items are [label, onSelect] or a divider. */
export type MenuItem = { label: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean } | "divider" | { note: ReactNode };
export function Menu({ items, label = "More", align = "right", trigger, triggerClassName = "icon-btn" }: { items: MenuItem[]; label?: string; align?: "left" | "right"; trigger?: ReactNode; triggerClassName?: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    setTimeout(() => wrap.current?.querySelector<HTMLElement>(".menu-item")?.focus(), 0);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        className={triggerClassName}
        aria-label={trigger ? undefined : label}
        title={trigger ? label : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((x) => !x);
        }}
      >
        {trigger ?? <MoreHorizontal className="lucide" />}
      </button>
      {open && (
        <div
          className={`menu ${align}`}
          role="menu"
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            const els = Array.from(wrap.current!.querySelectorAll<HTMLElement>(".menu-item:not(:disabled)"));
            const i = els.indexOf(document.activeElement as HTMLElement);
            els[(i + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length]?.focus();
          }}
        >
          {items.map((it, i) =>
            it === "divider" ? (
              <div key={i} className="menu-divider" />
            ) : "note" in it ? (
              <div key={i} className="menu-note">{it.note}</div>
            ) : (
              <button
                key={i}
                role="menuitem"
                className={`menu-item ${it.danger ? "danger" : ""}`}
                disabled={it.disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  it.onSelect();
                }}
              >
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Textarea that grows with its content. */
export function AutoGrow(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { minRows, ...rest } = props;
  const fit = () => {
    const el = ref.current;
    if (!el || !el.offsetParent) return; // hidden (e.g. the other tab on a phone): measure when shown
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  };
  useLayoutEffect(fit, [props.value]);
  // Re-measure when the width changes or the field becomes visible.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== w) {
        w = el.clientWidth;
        fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <textarea ref={ref} rows={minRows ?? 3} {...rest} />;
}

/** Debounced autosave. */
export function useDebounced<T>(value: T, ms: number, fn: (v: T) => void) {
  const first = useRef(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => fnRef.current(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
}

export function Dots({ label }: { label?: string }) {
  return (
    <span className="dots" role="img" aria-label={label ?? "Working"}>
      <i />
      <i />
      <i />
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <img src="/mark.svg" alt="" width={44} height={44} />
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

/** True while a media query matches; follows window resizes. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (f) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", f);
      return () => m.removeEventListener("change", f);
    },
    () => window.matchMedia(query).matches,
  );
}
