// Shared helpers for research items: the citation line and the three evidence states.
import { Check, CircleAlert, Flag, Minus, X } from "lucide-react";

export function citationFor(card: any): string {
  const s = card.sources?.find((x: any) => x.kind !== "bible_text") ?? card.sources?.[0];
  if (!s) return card.title;
  return `${s.title}${s.url ? ` — ${s.url}` : ""}`;
}

/** The three evidence states, kept separate (R3). Words are fixed: Source found, Quote matched, Interpretation reviewed. */
export function cardStatuses(card: any) {
  const src =
    card.status_source === "found"
      ? { icon: <Check className="lucide" />, text: "Source found", cls: "ok" }
      : card.status_source === "unavailable"
        ? { icon: <X className="lucide" />, text: "Source unavailable", cls: "bad" }
        : null; // Scripture cards need no source badge
  const quote =
    ({
      matched: { icon: <Check className="lucide" />, text: "Quote matched", cls: "ok" },
      matched_compiled: { icon: <Check className="lucide" />, text: "Quote matched", cls: "ok" },
      working_translation: { icon: <Minus className="lucide" />, text: "Paraphrase of a translation", cls: "" },
      dequoted: { icon: <CircleAlert className="lucide" />, text: "Changed to paraphrase", cls: "bad" },
      none: null,
    } as Record<string, any>)[card.status_quote as string] ?? null;
  const interp =
    card.status_interpretation === "reviewed"
      ? { icon: <Check className="lucide" />, text: "Interpretation reviewed", cls: "ok" }
      : card.status_interpretation === "disputed"
        ? { icon: <Flag className="lucide" />, text: "Disputed", cls: "bad" }
        : null; // unreviewed is the default; only your review shows
  return [src, quote, interp].filter(Boolean) as { icon: React.ReactNode; text: string; cls: string }[];
}
