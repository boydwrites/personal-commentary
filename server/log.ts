// JSON-lines log, rotated at 10 MB (keep 5). Never logs note, post, or source text; redacts credentials.
import fs from "node:fs";
import path from "node:path";
import { LOG_DIR, APP_ID } from "./config.ts";

const FILE = path.join(LOG_DIR, "personal-commentary.log");
const REDACT = /(authorization|x-api-key|api[_-]?key|token|code)(["'=:\s]+)([^"'&\s,}]+)/gi;

function rotate() {
  try {
    if (fs.statSync(FILE).size < 10 * 1024 * 1024) return;
  } catch {
    return;
  }
  for (let i = 4; i >= 1; i--) {
    const from = `${FILE}.${i}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${FILE}.${i + 1}`);
  }
  fs.renameSync(FILE, `${FILE}.1`);
}

export function log(level: "info" | "warn" | "error", component: string, event: string, extra: Record<string, unknown> = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, component, event, ...extra }).replace(REDACT, "$1$2[redacted]");
  try {
    rotate();
    fs.appendFileSync(FILE, line + "\n");
  } catch {
    /* logging must never break the app */
  }
  if (process.env.COMMENTARY_TEST !== "1" && level !== "info") console.error(line);
}

export function tailLog(lines = 200): string[] {
  try {
    return fs.readFileSync(FILE, "utf8").trim().split("\n").slice(-lines);
  } catch {
    return [];
  }
}
