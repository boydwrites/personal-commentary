// Your notes and pieces as reading text. They're written in a little Markdown (headings, "> " quotations, lists,
// **bold**, _italic_); this sets them for people. Small on purpose: React elements only, never raw HTML.
import type { ReactNode } from "react";

/** "words — Matthew 16:22 (BSB)" → the words, and the source they came from. A cite looks like a reference or a name. */
export function splitCite(line: string): { text: string; cite: string | null; at: number } {
  const m = line.match(/^(.*\S)(\s+[—–]\s+)([^—–]{2,90})$/);
  if (m && /^[\p{Lu}\d]/u.test(m[3].trim()) && m[3].trim().split(/\s+/).length <= 10) return { text: m[1].trim(), cite: m[3].trim(), at: m[1].length };
  return { text: line.trim(), cite: null, at: line.length };
}

type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "quote"; text: string; cite: string | null }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "rule" }
  | { kind: "p"; lines: string[] };

export function blocksOf(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ kind: "p", lines: para });
    para = [];
  };
  for (const raw of src.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    let m: RegExpMatchArray | null;
    if (!line.trim()) endPara();
    else if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/))) {
      endPara();
      blocks.push({ kind: "h", level: m[1].length, text: m[2].replace(/\s+#+$/, "") });
    } else if (/^\s*>/.test(line)) {
      endPara();
      const body = line.replace(/^\s*>\s?/, "");
      const last = blocks.at(-1);
      // A quotation that continues on the next ">" line (without a source yet) stays one quotation.
      if (last?.kind === "quote" && !last.cite && body.trim()) {
        const joined = splitCite(`${last.text} ${body}`);
        last.text = joined.text;
        last.cite = joined.cite;
      } else if (body.trim()) blocks.push({ kind: "quote", ...splitCite(body) });
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      endPara();
      blocks.push({ kind: "rule" });
    } else if ((m = line.match(/^\s{0,3}(?:([-*•])|(\d+)[.)])\s+(.*)$/))) {
      endPara();
      const ordered = !m[1];
      const last = blocks.at(-1);
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(m[3]);
      else blocks.push({ kind: "list", ordered, items: [m[3]] });
    } else {
      const last = blocks.at(-1);
      // A wrapped list item continues the item.
      if (!para.length && last?.kind === "list" && /^\s{2,}/.test(raw)) last.items[last.items.length - 1] += ` ${line.trim()}`;
      else para.push(line);
    }
  }
  endPara();
  return blocks;
}

/** **bold**, __bold__, *italic*, _italic_. Anything else is text. */
export function Inline({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const re = /(\*\*|__)(?=\S)([\s\S]*?\S)\1|(\*|_)(?=\S)([\s\S]*?\S)\3(?![\p{L}\p{N}])/gu;
  let last = 0;
  for (const m of text.matchAll(re)) {
    // An underscore inside a word (snake_case) isn't emphasis.
    if (m[3] === "_" && m.index! > 0 && /[\p{L}\p{N}]/u.test(text[m.index! - 1])) continue;
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push(m[1] ? <strong key={m.index}><Inline text={m[2]} /></strong> : <em key={m.index}><Inline text={m[4]} /></em>);
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

/** Markdown set as a page. `baseLevel` is the heading level a "#" maps to, so a piece's headings sit under the page's. */
export function Markdown({ text, className = "", baseLevel = 2 }: { text: string; className?: string; baseLevel?: number }) {
  const blocks = blocksOf(text);
  const top = Math.min(...blocks.filter((b) => b.kind === "h").map((b) => (b as { level: number }).level), 6);
  return (
    <div className={`md ${className}`}>
      {blocks.map((b, i) => {
        if (b.kind === "h") {
          const level = Math.min(6, baseLevel + (b.level - top));
          const H = `h${level}` as "h2";
          return <H key={i} className={`md-h md-h${level - baseLevel + 1}`}><Inline text={b.text} /></H>;
        }
        if (b.kind === "quote")
          return (
            <blockquote key={i} className="md-quote">
              <p><Inline text={b.text} /></p>
              {b.cite && <footer>{b.cite}</footer>}
            </blockquote>
          );
        if (b.kind === "list") {
          const L = b.ordered ? "ol" : "ul";
          return <L key={i} className="md-list">{b.items.map((it, j) => <li key={j}><Inline text={it} /></li>)}</L>;
        }
        if (b.kind === "rule") return <hr key={i} className="md-rule" />;
        const note = b.lines.length === 1 && /^_?\*?Note:/.test(b.lines[0]);
        return (
          <p key={i} className={note ? "md-note" : undefined}>
            {b.lines.map((l, j) => <span key={j}><Inline text={l} />{j < b.lines.length - 1 && <br />}</span>)}
          </p>
        );
      })}
    </div>
  );
}
