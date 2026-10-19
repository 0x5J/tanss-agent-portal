import { readFileSync } from "node:fs";

/**
 * The version this server runs, read once from package.json — the one place
 * a release sets it. The container ships package.json next to server/, so
 * the same path works there and in development.
 */
export const VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
