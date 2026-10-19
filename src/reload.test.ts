import { describe, expect, it } from "vitest";
import { claimReload, RELOADED_KEY } from "./reload.ts";

function memory(): Pick<Storage, "getItem" | "setItem"> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

describe("claimReload", () => {
  it("allows one reload per version and tab", () => {
    const store = memory();
    expect(claimReload("0.2.0", store)).toBe(true);
    expect(store.data.get(RELOADED_KEY)).toBe("0.2.0");
    expect(claimReload("0.2.0", store)).toBe(false);
    expect(claimReload("0.2.0", store)).toBe(false);
  });

  it("allows another reload for the next version", () => {
    const store = memory();
    expect(claimReload("0.2.0", store)).toBe(true);
    expect(claimReload("0.3.0", store)).toBe(true);
  });

  it("never reloads without a usable session storage", () => {
    expect(claimReload("0.2.0", null)).toBe(false);
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(claimReload("0.2.0", broken)).toBe(false);
  });
});
