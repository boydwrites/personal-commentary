import type { DB } from "./db.ts";
import { nowIso } from "./db.ts";
import { BANNED_PHRASES } from "./seed.ts";
import type { WritingFormat } from "../shared/writing.ts";

export interface Preferences {
  onboarded: boolean;
  translation: string; // 'BSB' (local, public domain) is the only translation today
  translationName: string;
  theologicalFrame: string;
  niceneFloor: boolean;
  careTopics: string[];
  voicePrinciples: string;
  approvedExamples: string[];
  bannedPhrases: string[];
  xHandle: string; // without @
  xDisplayName: string;
  premium: boolean;
  postSourceReply: boolean;
  replyWindowReminder: boolean;
  passageOrder: ("open" | "series" | "sunday" | "votd")[];
  sundayText: { ref: string; date: string } | null;
  budgets: { perRunUsd: number; perStudyUsd: number; monthlyOpenaiUsd: number; monthlyXUsd: number };
  lastFormat: WritingFormat;
  /** One-time repairs already run on this database (server/repair.ts). */
  repairs: string[];
}

export const DEFAULT_PREFS: Preferences = {
  onboarded: false,
  translation: "BSB",
  translationName: "Berean Standard Bible",
  theologicalFrame: "",
  niceneFloor: true,
  careTopics: ["Israel and the Jewish people", "Suffering and illness", "Sexuality", "Politics"],
  voicePrinciples: "Plain words. One idea per post. Let the text and the sources do the work; say what I think as my own view.",
  approvedExamples: [],
  bannedPhrases: BANNED_PHRASES,
  xHandle: "",
  xDisplayName: "",
  premium: false,
  postSourceReply: true,
  replyWindowReminder: true,
  passageOrder: ["open", "series", "sunday", "votd"],
  sundayText: null,
  budgets: { perRunUsd: 2, perStudyUsd: 3, monthlyOpenaiUsd: 45, monthlyXUsd: 10 },
  lastFormat: "journal",
  repairs: [],
};

export function getPrefs(db: DB): Preferences {
  const rows = db.prepare("SELECT key, value_json FROM preferences").all() as { key: string; value_json: string }[];
  const out: any = structuredClone(DEFAULT_PREFS);
  for (const r of rows) {
    if (!(r.key in DEFAULT_PREFS)) continue;
    try {
      out[r.key] = JSON.parse(r.value_json);
    } catch {
      /* keep default */
    }
  }
  // Preserve the user's existing monthly limit when upgrading from Anthropic.
  const stored = out.budgets ?? {};
  out.budgets = { ...DEFAULT_PREFS.budgets, ...stored,
    monthlyOpenaiUsd: stored.monthlyOpenaiUsd ?? stored.monthlyAnthropicUsd ?? DEFAULT_PREFS.budgets.monthlyOpenaiUsd };
  delete out.budgets.monthlyAnthropicUsd;
  for (const [name, fallback] of Object.entries(DEFAULT_PREFS.budgets)) {
    if (typeof out.budgets[name] !== "number" || !Number.isFinite(out.budgets[name]) || out.budgets[name] < 0) out.budgets[name] = fallback;
  }
  return out as Preferences;
}

export function setPrefs(db: DB, patch: Partial<Preferences>) {
  const up = db.prepare("INSERT INTO preferences (key, value_json, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at");
  const now = nowIso();
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_PREFS) up.run(k, JSON.stringify(v), now);
  })();
}

export function translationAbbrev(p: Preferences) {
  return p.translation;
}
