import type { PostFormat } from "./counting.ts";

export const WRITING_FORMATS = ["single", "long", "thread", "journal", "devotional", "notes"] as const;
export type WritingFormat = typeof WRITING_FORMATS[number];
export type RefinementMode = "polish" | "shorten" | "clarify";

export function isXFormat(format: string): format is PostFormat {
  return format === "single" || format === "long" || format === "thread";
}

export const WRITING_LABELS: Record<WritingFormat, string> = {
  single: "X post", long: "Long X post", thread: "X thread",
  journal: "Journal entry", devotional: "Devotional", notes: "Study notes",
};
