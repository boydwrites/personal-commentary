// Daily database backups. SQLite's online backup API writes one consistent, self-contained file,
// even while the app is writing, so a backup never depends on a separate -wal file.
import fs from "node:fs";
import path from "node:path";
import { Cron } from "croner";
import type { DB } from "./db.ts";
import { localDate } from "./db.ts";
import { BACKUP_DIR, BACKUPS_KEPT } from "./config.ts";
import { log } from "./log.ts";

const NAME = /^personal-commentary-(\d{4}-\d{2}-\d{2})\.db$/;

export function listBackups(): { file: string; date: string; bytes: number; at: string }[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((n) => NAME.test(n))
    .map((n) => {
      const st = fs.statSync(path.join(BACKUP_DIR, n));
      return { file: n, date: n.match(NAME)![1], bytes: st.size, at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Backs up to today's file (replacing an earlier one from today), then keeps the newest BACKUPS_KEPT. */
export async function backupNow(db: DB) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `personal-commentary-${localDate()}.db`);
  const tmp = `${file}.partial`;
  await db.backup(tmp);
  fs.renameSync(tmp, file);
  // Only files this job made are pruned; anything else in the folder is left alone.
  for (const old of listBackups().slice(BACKUPS_KEPT)) fs.rmSync(path.join(BACKUP_DIR, old.file));
  log("info", "backup", "written", { file: path.basename(file) });
  return listBackups()[0];
}

/** One backup a day: at start if today's is missing, then at 03:00 while the app runs. */
export function scheduleBackups(db: DB) {
  const run = async () => {
    await backupNow(db).catch((e) => log("error", "backup", "failed", { error: String(e) }));
  };
  if (!listBackups().some((b) => b.date === localDate())) run();
  return new Cron("0 3 * * *", run);
}
