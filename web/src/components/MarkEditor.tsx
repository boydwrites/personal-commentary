// Plain text you write in, set like the page it will become. A transparent textarea sits over a styled copy of its
// own text: headings in the brand's ink, quotations highlighted with their source quieter, Markdown marks faint.
// Nothing changes the width of a letter (no size, weight, or italic changes), so the caret always lines up.
import { useEffect, useLayoutEffect, useRef, type ReactNode, type TextareaHTMLAttributes } from "react";
import { splitCite } from "./Markdown";

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*|__)(?=\S)(.*?\S)\1/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push(
      <span key={`${key}-${m.index}`}>
        <span className="mk-mark">{m[1]}</span>
        <span className="mk-b">{m[2]}</span>
        <span className="mk-mark">{m[1]}</span>
      </span>,
    );
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

/** One line of the styled copy. */
export function MirrorLine({ line, k }: { line: string; k: string }) {
  let m: RegExpMatchArray | null;
  if ((m = line.match(/^(\s{0,3}#{1,6}\s+)(.*)$/)))
    return <span className="mk-h"><span className="mk-mark">{m[1]}</span>{inline(m[2], k)}</span>;
  if ((m = line.match(/^(\s*>\s?)(.*)$/))) {
    const { cite, at } = splitCite(m[2]);
    // Only the quoted words are highlighted; the ">" and the source stay quiet.
    return (
      <>
        <span className="mk-mark kept-mark">{m[1]}</span>
        <span className="kept">{m[2].slice(0, at)}</span>
        {cite && <span className="mk-cite">{m[2].slice(at)}</span>}
      </>
    );
  }
  if ((m = line.match(/^(\s{0,3}(?:[-*•]|\d+[.)])\s+)(.*)$/))) return <><span className="mk-mark">{m[1]}</span>{inline(m[2], k)}</>;
  return <>{inline(line, k)}</>;
}

export function Mirror({ value, className = "" }: { value: string; className?: string }) {
  return (
    <div className={`mk-text mk-mirror ${className}`} aria-hidden="true">
      {value.split("\n").map((line, i, all) => (
        <span key={i}>
          <MirrorLine line={line} k={String(i)} />
          {i < all.length - 1 ? "\n" : "​"}
        </span>
      ))}
    </div>
  );
}

/** A growing textarea over its styled copy. */
export function MarkEditor({ value, className = "", textareaRef, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string; textareaRef?: React.RefObject<HTMLTextAreaElement | null> }) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ta = textareaRef ?? own;
  const fit = () => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(fit, [value]);
  useEffect(() => {
    const el = ta.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className={`mk-wrap ${className}`}>
      <Mirror value={value} />
      <textarea ref={ta} className="mk-text mk-input" value={value} {...rest} />
    </div>
  );
}
