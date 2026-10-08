import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** The app's display name lives here and only here. */
export const APP_NAME = "Personal Commentary";
/** Internal id: data folder, log folder, Keychain service, and user agent. Changing it would orphan existing data and keys. */
export const APP_ID = "PersonalCommentary";
export const APP_VERSION = "0.1.0";
export const PUBLICATION = "Personal Commentary";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.COMMENTARY_DATA_DIR ?? path.join(os.homedir(), "Library", "Application Support", APP_ID);
export const LOG_DIR = process.env.COMMENTARY_LOG_DIR ?? path.join(os.homedir(), "Library", "Logs", APP_ID);
export const DATASET_DIR = process.env.COMMENTARY_DATASET_DIR ?? path.join(DATA_DIR, "datasets");
export const CACHE_DIR = path.join(DATA_DIR, "cache", "http");
export const BACKUP_DIR = path.join(DATA_DIR, "backups");
export const EXPORT_DIR = path.join(DATA_DIR, "exports");
/** Readable Markdown records. Tests and demo keep records beside their isolated data. */
export const NOTES_DIR = process.env.COMMENTARY_NOTES_DIR ?? (process.env.COMMENTARY_DATA_DIR ? path.join(DATA_DIR, "notes") : path.join(os.homedir(), "Documents", "Personal Commentary"));
/** Daily database backups kept before the oldest is removed. */
export const BACKUPS_KEPT = 14;

export const PORTS = [8790, 8791, 8792, 8793, 8794, 8795, 8796, 8797, 8798, 8799];
export const USER_AGENT = `${APP_ID}/1.0 (personal study tool)`;
export const RESEARCH_MODEL = "gpt-6-luna";
export const WRITING_MODEL = "gpt-6.1-sol";
export type Model = typeof RESEARCH_MODEL | typeof WRITING_MODEL;

export const DB_FILE = path.join(DATA_DIR, "personal-commentary.db");

for (const d of [DATA_DIR, LOG_DIR, DATASET_DIR, CACHE_DIR, BACKUP_DIR, EXPORT_DIR]) fs.mkdirSync(d, { recursive: true });

export const DATASET_PATHS = {
  hcf: path.join(DATASET_DIR, "hcf", "commentaries.sqlite"),
  openbible: path.join(DATASET_DIR, "openbible", "cross-references.zip"),
  bsb: path.join(DATASET_DIR, "bible", "BSB.json"),
  stepbible: path.join(DATASET_DIR, "stepbible", "stepbible.sqlite"),
};
