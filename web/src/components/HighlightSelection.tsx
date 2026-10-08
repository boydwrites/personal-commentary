// Select words anywhere marked data-keep (the passage, a finding, a source) and highlight them: the line lands in
// your notebook as a quote, with its source, ready for you to write under it. A line from a finding highlights the finding too.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Highlighter } from "lucide-react";
import { api } from "../api";
import { addToNote } from "../notes";
import { displayRef } from "../../../shared/refs.ts";
import { useToast } from "./ui";

/**
 * Where a selected line came from, said exactly:
 * - in a passage, the verses it actually spans ("Matthew 16:22 (BSB)"), not the study's reference;
 * - in a finding, the source's own words (a checked quotation) cite the source, and the brief's summary cites the brief.
 */
function citeFor(host: HTMLElement, range: Range): string | null {
  if (host.dataset.book) {
    const verses = [...host.querySelectorAll<HTMLElement>("[data-v]")].filter((v) => range.intersectsNode(v));
    if (verses.length) {
      const [c1, v1] = verses[0].dataset.v!.split(":").map(Number);
      const [c2, v2] = verses.at(-1)!.dataset.v!.split(":").map(Number);
      return `${displayRef({ book: host.dataset.book, c1, v1, c2, v2 } as any)}${host.dataset.translation ? ` (${host.dataset.translation})` : ""}`;
    }
  }
  if (host.dataset.keepSummary) {
    const at = range.commonAncestorContainer;
    const quote = (at instanceof Element ? at : at.parentElement)?.closest<HTMLElement>(".qt");
    return quote && host.contains(quote) ? host.dataset.keep || null : host.dataset.keepSummary;
  }
  return host.dataset.keep || null;
}

export function HighlightSelection({ studyId, onChanged }: { studyId: string; onChanged: () => void }) {
  const toast = useToast();
  const [sel, setSel] = useState<{ text: string; cite: string | null; card: string | null; x: number; y: number } | null>(null);

  useEffect(() => {
    const read = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed || !s.rangeCount) return setSel(null);
      const node = s.anchorNode instanceof Element ? s.anchorNode : s.anchorNode?.parentElement;
      const host = node?.closest<HTMLElement>("[data-keep]");
      if (!host || !host.contains(s.focusNode)) return setSel(null);
      // Never offer to highlight inside an editor.
      if (node?.closest("textarea, input, [contenteditable]")) return setSel(null);
      // A selection that starts or ends inside a word takes the whole word, and shows it. One that ends just
      // before a word (or starts just after one) is left alone.
      const range = s.getRangeAt(0).cloneRange();
      const word = /[\p{L}\p{N}’'-]/u;
      if (range.startContainer.nodeType === Node.TEXT_NODE) {
        const t = range.startContainer.textContent ?? "";
        let i = range.startOffset;
        if (word.test(t[i] ?? "")) while (i > 0 && word.test(t[i - 1])) i--;
        range.setStart(range.startContainer, i);
      }
      if (range.endContainer.nodeType === Node.TEXT_NODE) {
        const t = range.endContainer.textContent ?? "";
        let j = range.endOffset;
        if (j > 0 && word.test(t[j - 1])) while (j < t.length && word.test(t[j])) j++;
        range.setEnd(range.endContainer, j);
      }
      // Verse numbers aren't part of the words.
      const frag = range.cloneContents();
      frag.querySelectorAll("sup").forEach((n) => n.remove());
      const text = (frag.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text.split(" ").length < 2 || text.length > 1200) return setSel(null);
      if (range.toString() !== s.toString()) {
        s.removeAllRanges();
        s.addRange(range);
      }
      const r = range.getBoundingClientRect();
      setSel({ text, cite: citeFor(host, range), card: host.closest<HTMLElement>("[data-card]")?.dataset.card ?? null, x: r.left + r.width / 2, y: r.top });
    };
    const onUp = () => setTimeout(read, 0);
    const onChange = () => {
      if (window.getSelection()?.isCollapsed) setSel(null);
    };
    const onScroll = () => setSel(null);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("keyup", onUp);
    document.addEventListener("selectionchange", onChange);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keyup", onUp);
      document.removeEventListener("selectionchange", onChange);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, []);

  if (!sel) return null;
  const highlight = async () => {
    const k = { text: sel.text, cite: sel.cite };
    const card = sel.card;
    setSel(null);
    window.getSelection()?.removeAllRanges();
    try {
      const how = await addToNote(studyId, k);
      if (card) {
        await api(`/api/cards/${card}`, { method: "PATCH", body: { selected: true } });
        onChanged();
      }
      if (how === "saved") toast("Highlighted. It's in your notes.");
    } catch (e: any) {
      toast(`That line wasn't highlighted: ${e.message} Select it and try again.`, "error");
    }
  };
  return createPortal(
    <button
      className="hl-pop"
      style={{ left: Math.max(70, Math.min(window.innerWidth - 70, sel.x)), top: Math.max(8, sel.y - 42) }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={highlight}
    >
      <Highlighter className="lucide" /> Highlight
    </button>,
    document.body,
  );
}
