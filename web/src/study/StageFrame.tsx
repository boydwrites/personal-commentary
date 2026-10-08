// Every stage has the same shape: what you're working with in the middle, your notebook on the right.
// In a wide window the notebook's edge can be dragged to any width (remembered on this Mac; double-click resets it).
// In a narrow window the notebook opens as a sheet from the header (or, while reading, sits under the passage).
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { X } from "lucide-react";
import { Drawer } from "../components/ui";

export type Layout = { wide: boolean; sheet: boolean; setSheet: (open: boolean) => void };

const WIDTH_KEY = "commentary.notebook.width";
const MIN_ASIDE = 300;
const MIN_MAIN = 420;

function savedWidth(): number | null {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return v >= MIN_ASIDE ? v : null;
  } catch {
    return null;
  }
}
function saveWidth(w: number | null) {
  try {
    if (w === null) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
  } catch {
    /* the width just won't be remembered */
  }
}

export function StageFrame({
  layout, main, aside, asideLabel, kind, inlineWhenNarrow = false,
}: {
  layout: Layout; main: ReactNode; aside: ReactNode; asideLabel: string; kind: string; inlineWhenNarrow?: boolean;
}) {
  const [width, setWidth] = useState<number | null>(savedWidth);
  const stage = useRef<HTMLDivElement>(null);
  if (layout.wide)
    return (
      <div ref={stage} className={`stage stage-${kind}`} style={width ? ({ "--aside-w": `${width}px` } as CSSProperties) : undefined}>
        <div className="stage-main">{main}</div>
        <Resizer stage={stage} width={width} setWidth={setWidth} />
        <aside className="stage-aside" aria-label={asideLabel}>{aside}</aside>
      </div>
    );
  return (
    <div className={`stage narrow stage-${kind}`}>
      <div className="stage-main">
        {main}
        {inlineWhenNarrow && <aside className="stage-inline" aria-label={asideLabel}>{aside}</aside>}
      </div>
      {!inlineWhenNarrow && (
        <Drawer open={layout.sheet} onClose={() => layout.setSheet(false)} label={asideLabel}>
          <div className="sheet">
            <button className="icon-btn sheet-close" onClick={() => layout.setSheet(false)} aria-label="Close">
              <X className="lucide" />
            </button>
            {aside}
          </div>
        </Drawer>
      )}
    </div>
  );
}

/** The notebook's left edge: drag it, use the arrow keys, or double-click to go back to the default width. */
function Resizer({ stage, width, setWidth }: { stage: React.RefObject<HTMLDivElement | null>; width: number | null; setWidth: (w: number | null) => void }) {
  const bounds = () => {
    const total = stage.current?.getBoundingClientRect().width ?? 1200;
    return { min: MIN_ASIDE, max: Math.max(MIN_ASIDE, Math.min(1100, total - MIN_MAIN)) };
  };
  const current = () => stage.current?.querySelector<HTMLElement>(".stage-aside")?.getBoundingClientRect().width ?? width ?? 400;
  const clamp = (w: number) => {
    const b = bounds();
    return Math.min(b.max, Math.max(b.min, w));
  };
  const apply = (w: number | null) => {
    setWidth(w);
    saveWidth(w);
  };
  return (
    <div
      className="stage-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Notebook width"
      aria-valuemin={MIN_ASIDE}
      aria-valuemax={bounds().max}
      aria-valuenow={Math.round(width ?? current())}
      tabIndex={0}
      title="Drag to resize the notebook. Double-click for the default width."
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const right = stage.current!.getBoundingClientRect().right;
        document.body.classList.add("resizing");
        let next = current();
        const move = (ev: PointerEvent) => {
          next = clamp(right - ev.clientX);
          stage.current?.style.setProperty("--aside-w", `${next}px`);
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
          document.body.classList.remove("resizing");
          apply(next);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      }}
      onDoubleClick={() => {
        stage.current?.style.removeProperty("--aside-w");
        apply(null);
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        apply(clamp(current() + (e.key === "ArrowLeft" ? 32 : -32)));
      }}
    />
  );
}
