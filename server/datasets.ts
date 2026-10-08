// Local datasets: the Berean Standard Bible, the Church Fathers commentary database, OpenBible cross-references,
// and STEPBible's tagged Hebrew and Greek with its lexicons.
import fs from "node:fs";
import path from "node:path";
import { DATASET_PATHS } from "./config.ts";
import { downloadFile } from "./fetcher.ts";
import { emit } from "./events.ts";
import { resetBsbCache } from "./bible.ts";
import { closeHcf, resetXrefs } from "./sources/gatherers.ts";
import { STEPBIBLE_FILES, buildStepbibleIndex, closeStepbible } from "./sources/stepbible.ts";
import { log } from "./log.ts";

export const DATASETS = {
  bsb: { name: "Berean Standard Bible", url: "https://bible.helloao.org/api/BSB/complete.json", path: DATASET_PATHS.bsb, approx: "8 MB", license: "Public domain", required: true },
  hcf: { name: "Church Fathers commentary database", url: "https://github.com/HistoricalChristianFaith/Commentaries-Database/releases/download/latest/commentaries.sqlite", path: DATASET_PATHS.hcf, approx: "160 MB", license: "Public domain compilation (some fair-use excerpts)", required: false },
  openbible: { name: "OpenBible cross-references", url: "https://a.openbible.info/data/cross-references.zip", path: DATASET_PATHS.openbible, approx: "2 MB", license: "CC BY (openbible.info)", required: false },
  stepbible: { name: "Hebrew and Greek words (STEPBible)", url: STEPBIBLE_FILES[0], path: DATASET_PATHS.stepbible, approx: "108 MB download, 50 MB kept", license: "CC BY 4.0 (STEPBible.org)", required: false },
} as const;
export type DatasetName = keyof typeof DATASETS;

const inProgress = new Map<DatasetName, { received: number; total: number | null; error?: string }>();

export function datasetStatus() {
  return (Object.keys(DATASETS) as DatasetName[]).map((k) => {
    const d = DATASETS[k];
    let size = 0;
    let mtime: string | null = null;
    try {
      const st = fs.statSync(d.path);
      size = st.size;
      mtime = st.mtime.toISOString();
    } catch {
      /* missing */
    }
    return { id: k, name: d.name, approx: d.approx, license: d.license, required: d.required, present: size > 0, size, updatedAt: mtime, progress: inProgress.get(k) ?? null };
  });
}

export async function downloadDataset(name: DatasetName) {
  if (inProgress.has(name) && !inProgress.get(name)!.error) return;
  const d = DATASETS[name];
  inProgress.set(name, { received: 0, total: null });
  emit("datasets", datasetStatus());
  try {
    if (name === "hcf") closeHcf();
    if (name === "stepbible") await downloadStepbible((received, total) => {
      inProgress.set(name, { received, total });
      emit("datasets", datasetStatus());
    });
    else await downloadFile(d.url, d.path, (received, total) => {
      inProgress.set(name, { received, total });
      emit("datasets", datasetStatus());
    });
    if (name === "bsb") resetBsbCache();
    if (name === "openbible") resetXrefs();
    inProgress.delete(name);
    log("info", "datasets", "downloaded", { name });
  } catch (e) {
    inProgress.set(name, { received: 0, total: null, error: e instanceof Error ? e.message : String(e) });
    log("warn", "datasets", "download_failed", { name, error: String(e) });
  }
  emit("datasets", datasetStatus());
}

/** Eight raw files (about 108 MB), indexed into one SQLite file; the raw files are removed afterwards. */
async function downloadStepbible(onProgress: (received: number, total: number | null) => void) {
  const dir = path.join(path.dirname(DATASET_PATHS.stepbible), "raw");
  fs.mkdirSync(dir, { recursive: true });
  const APPROX_TOTAL = 108_000_000;
  let done = 0;
  const files: string[] = [];
  for (const [i, url] of STEPBIBLE_FILES.entries()) {
    const dest = path.join(dir, `${i}.txt`);
    await downloadFile(url, dest, (received) => onProgress(done + received, APPROX_TOTAL));
    done += fs.statSync(dest).size;
    files.push(dest);
  }
  closeStepbible();
  buildStepbibleIndex(files);
  fs.rmSync(dir, { recursive: true, force: true });
}
