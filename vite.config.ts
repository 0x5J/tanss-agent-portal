import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    // API_URL points the dev UI at another backend, e.g. a local mock.
    proxy: {
      "/auth": process.env.API_URL ?? "http://127.0.0.1:3848",
      "/me": process.env.API_URL ?? "http://127.0.0.1:3848",
    },
  },
});
