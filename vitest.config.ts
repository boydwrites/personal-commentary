import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Keep every test away from the real data and log folders, including tests that import server modules.
// One fixed folder, emptied at the start of each run, so runs don't pile up in the temp directory.
const tmp = path.join(os.tmpdir(), "personal-commentary-vitest");
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp);

export default defineConfig({
  test: {
    root: ".",
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    pool: "forks",
    env: {
      COMMENTARY_TEST: "1",
      COMMENTARY_DATA_DIR: tmp,
      COMMENTARY_LOG_DIR: tmp,
      COMMENTARY_DATASET_DIR: process.env.COMMENTARY_DATASET_DIR ?? path.join(tmp, "datasets"),
    },
  },
});
