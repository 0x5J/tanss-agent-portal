import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

const BASE = {
  SESSION_SECRET: "x".repeat(32),
  TANSS_BASE_URL: "https://tanss.example",
};

describe("update settings", () => {
  it("defaults to the stable channel with checks on", () => {
    const config = loadConfig({ ...BASE });
    expect(config.updateChannel).toBe("stable");
    expect(config.updateCheck).toBe(true);
  });

  it("takes the staging channel", () => {
    expect(loadConfig({ ...BASE, UPDATE_CHANNEL: "staging" }).updateChannel).toBe("staging");
    expect(loadConfig({ ...BASE, UPDATE_CHANNEL: "stable" }).updateChannel).toBe("stable");
  });

  it("treats an empty channel as unset", () => {
    expect(loadConfig({ ...BASE, UPDATE_CHANNEL: "" }).updateChannel).toBe("stable");
  });

  it("refuses an unknown channel at startup", () => {
    expect(() => loadConfig({ ...BASE, UPDATE_CHANNEL: "beta" })).toThrow(/UPDATE_CHANNEL.*stable.*staging/);
  });

  it("switches the check off with UPDATE_CHECK=0 only", () => {
    expect(loadConfig({ ...BASE, UPDATE_CHECK: "0" }).updateCheck).toBe(false);
    expect(loadConfig({ ...BASE, UPDATE_CHECK: "1" }).updateCheck).toBe(true);
    expect(loadConfig({ ...BASE, UPDATE_CHECK: "" }).updateCheck).toBe(true);
  });
});
