import { Check, ChevronDown, X } from "lucide-react";
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ConnectionState } from "../../shared/types";

/** The ryxnroam mark: ryxnontop's inverse "r" tile, with a location arrow in place of ↗. */
export function NavGlyph(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 11.5 20 4l-7.5 16-2-6.5z" fill="currentColor" />
    </svg>
  );
}

export function BrandEmblem() {
  return (
    <span className="brand-emblem" aria-hidden="true">
      r<NavGlyph />
    </span>
  );
}

export function StatusDot({ state, live, className = "" }: { state?: ConnectionState | "failed" | "idle"; live?: boolean; className?: string }) {
  return <i className={`dot ${state ?? ""} ${live ? "live" : ""} ${className}`} aria-hidden="true" />;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

/** App-owned select menu (same interaction model as ryxnontop's SelectMenu). */
export function SelectMenu<T extends string>({
  label,
  value,
  options,
  onChange,
  placement = "down",
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  placement?: "up" | "down";
}) {
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = Math.max(0, options.findIndex((o) => o.value === value));
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const choose = (i: number) => {
    onChange(options[i].value);
    setOpen(false);
  };
  return (
    <div className="select" ref={root}>
      <button
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          setHl(selected);
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp"].includes(e.key)) {
            e.preventDefault();
            if (!open) {
              setOpen(true);
              setHl(selected);
              return;
            }
            setHl((h) => (h + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
          } else if ((e.key === "Enter" || e.key === " ") && open) {
            e.preventDefault();
            choose(hl);
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          } else if (e.key === "Tab") setOpen(false);
        }}
      >
        <span>{options[selected]?.label ?? value}</span>
        <ChevronDown />
      </button>
      {open && (
        <div id={id} role="listbox" aria-label={label} className={`popover select-options ${placement === "up" ? "up" : ""}`}>
          {options.map((o, i) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              tabIndex={-1}
              className={hl === i ? "highlighted" : ""}
              onMouseEnter={() => setHl(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(i)}
            >
              <span>{o.label}</span>
              {o.value === value && <Check />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Dialog shell with enter/exit motion, Escape to close and focus containment. */
export function Modal({
  onClose,
  className = "",
  children,
  label,
  closable = true,
}: {
  onClose: () => void;
  className?: string;
  children: ReactNode;
  label: string;
  closable?: boolean;
}) {
  const [closing, setClosing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, 150);
  };
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // Focus an explicitly marked field; otherwise the dialog itself, so nothing shows a ring on open.
    const marked = ref.current?.querySelector<HTMLElement>("[data-autofocus]");
    (marked ?? ref.current)?.focus({ preventScroll: true });
    return () => prev?.focus?.();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closable) {
        e.preventDefault();
        close();
      }
      if (e.key === "Tab" && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>("button:not(:disabled), input, textarea, [tabindex]:not([tabindex='-1'])")];
        if (!items.length) return;
        const [a, b] = [items[0], items[items.length - 1]];
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          b.focus();
        } else if (!e.shiftKey && document.activeElement === b) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <div className={`scrim ${closing ? "closing" : ""}`} onMouseDown={(e) => e.target === e.currentTarget && closable && close()}>
      <div ref={ref} className={`dialog ${className}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} style={{ outline: "none" }}>
        {closable && (
          <button className="dialog-close" aria-label="Close" title="Close" onClick={close}>
            <X />
          </button>
        )}
        <ModalCloseContext.Provider value={close}>{children}</ModalCloseContext.Provider>
      </div>
    </div>
  );
}

const ModalCloseContext = createContext<() => void>(() => {});
/** Close the surrounding Modal with its exit animation. */
export const useModalClose = () => useContext(ModalCloseContext);

export function Skeleton({ w = "100%", h = 12 }: { w?: number | string; h?: number }) {
  return <span className="skeleton" style={{ display: "block", width: w, height: h }} />;
}
