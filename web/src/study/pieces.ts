// What a study can become. Four pieces, grouped by who they're for; an X post comes in three shapes.
import { BookOpen, FileText, NotebookPen, Send, type LucideIcon } from "lucide-react";
import { isXFormat, WRITING_LABELS, type WritingFormat } from "../../../shared/writing.ts";

export type PieceKind = "journal" | "notes" | "devotional" | "x";

export interface Piece {
  kind: PieceKind;
  /** The format a new piece of this kind starts in. */
  format: WritingFormat;
  label: string;
  audience: "For you" | "To share";
  description: string;
  shape: string;
  Icon: LucideIcon;
}

export const PIECES: Piece[] = [
  { kind: "journal", format: "journal", label: "Journal entry", audience: "For you", description: "The story of your study: what you noticed, what you learned, and what you now believe.", shape: "A page in your voice", Icon: NotebookPen },
  { kind: "notes", format: "notes", label: "Study notes", audience: "For you", description: "Your thoughts and highlights, organized under headings to keep and return to.", shape: "Headings and points", Icon: FileText },
  { kind: "devotional", format: "devotional", label: "Devotional", audience: "To share", description: "The passage and one idea, developed in two or three paragraphs for a reader.", shape: "Two or three paragraphs", Icon: BookOpen },
  { kind: "x", format: "single", label: "X post", audience: "To share", description: "One clear thought for X, as a post, a long post, or a short thread.", shape: "280 characters or a thread", Icon: Send },
];

export const pieceOf = (format: WritingFormat): Piece => PIECES.find((p) => (p.kind === "x" ? isXFormat(format) : p.format === format)) ?? PIECES[0];

/** "X post", "X thread", "Journal entry"… */
export const formatLabel = (format: WritingFormat) => WRITING_LABELS[format] ?? "Piece";
/** A label inside a sentence: "your journal entry", "your X post" (X keeps its capital). */
export const inSentence = (label: string) => label.replace(/^(?!X\b)\w/, (c) => c.toLowerCase());

export const X_SHAPES: { format: WritingFormat; label: string }[] = [
  { format: "single", label: "Post" },
  { format: "long", label: "Long post" },
  { format: "thread", label: "Thread" },
];
