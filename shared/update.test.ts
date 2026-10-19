import { describe, expect, it } from "vitest";
import {
  compareVersions,
  isBusy,
  isVersion,
  updateBanner,
  type UpdateOverview,
  type UpdateStatus,
} from "./update.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function overview(patch: Partial<UpdateOverview> = {}): UpdateOverview {
  return {
    current: "0.1.0",
    channel: "stable",
    enabled: true,
    latest: null,
    checkedAt: NOW - MIN,
    checkError: null,
    updater: "ready",
    requested: null,
    status: null,
    ...patch,
  };
}

function release(version: string, prerelease = false) {
  return {
    version,
    notes: "",
    url: `https://example.test/${version}`,
    prerelease,
    publishedAt: "2026-10-19T08:00:00Z",
  };
}

function status(patch: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    id: "u1",
    state: "pulling",
    from: "0.1.0",
    to: "0.2.0",
    message: "",
    at: NOW - MIN,
    ...patch,
  };
}

describe("compareVersions", () => {
  it("compares numerically, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });

  it("throws on anything that is not X.Y.Z", () => {
    expect(() => compareVersions("v1.0.0", "1.0.0")).toThrow();
    expect(() => compareVersions("1.0.0", "1.0")).toThrow();
  });
});

describe("isVersion", () => {
  it("accepts only plain X.Y.Z", () => {
    expect(isVersion("1.2.3")).toBe(true);
    expect(isVersion("v1.0.0")).toBe(false);
    expect(isVersion("1.0.0-rc.1")).toBe(false);
    expect(isVersion("")).toBe(false);
  });
});

describe("isBusy", () => {
  it("is busy while a request is still open", () => {
    const requested = { id: "u1", version: "0.2.0", requestedAt: NOW };
    expect(isBusy({ requested, status: null }, NOW)).toBe(true);
  });

  it("is busy while the updater reports progress", () => {
    for (const state of ["pulling", "starting", "checking"] as const) {
      const s = status({ state, at: NOW - MIN });
      expect(isBusy({ requested: null, status: s }, NOW)).toBe(true);
    }
  });

  it("gives up on progress that has not moved for ten minutes", () => {
    const s = status({ at: NOW - 11 * MIN });
    expect(isBusy({ requested: null, status: s }, NOW)).toBe(false);
  });

  it("is not busy once the update has ended", () => {
    for (const state of ["done", "failed", "rolledBack"] as const) {
      const s = status({ state });
      expect(isBusy({ requested: null, status: s }, NOW)).toBe(false);
    }
    expect(isBusy({ requested: null, status: null }, NOW)).toBe(false);
  });
});

describe("updateBanner", () => {
  it("offers a newer release when the updater is ready", () => {
    const banner = updateBanner(overview({ latest: release("0.2.0") }), NOW);
    expect(banner).toMatchObject({ tone: "info", action: "update" });
    expect(banner?.text).toContain("Version 0.2.0 verfügbar");
    expect(banner?.text).toContain("0.1.0");
  });

  it("marks staging pre-releases", () => {
    const banner = updateBanner(
      overview({ channel: "staging", latest: release("0.2.0", true) }),
      NOW,
    );
    expect(banner?.text).toContain("Staging");
    expect(banner?.action).toBe("update");
  });

  it("tells how to update by hand when the updater is missing", () => {
    const banner = updateBanner(
      overview({ updater: "missing", latest: release("0.2.0") }),
      NOW,
    );
    expect(banner?.tone).toBe("info");
    expect(banner?.action).toBeNull();
    expect(banner?.text).toContain("Version 0.2.0 verfügbar");
    expect(banner?.text).toContain("docker compose pull && docker compose up -d");
  });

  it("shows progress while an update runs", () => {
    const banner = updateBanner(
      overview({ latest: release("0.2.0"), status: status({ state: "pulling" }) }),
      NOW,
    );
    expect(banner).toMatchObject({ tone: "progress", action: null });
    expect(banner?.text).toBe("Update auf 0.2.0: Image wird geladen …");
  });

  it("words every step of the update", () => {
    const text = (state: UpdateStatus["state"]) =>
      updateBanner(overview({ status: status({ state }) }), NOW)?.text;
    expect(text("starting")).toBe("Update auf 0.2.0: Portal startet neu …");
    expect(text("checking")).toBe("Update auf 0.2.0: neue Version wird geprüft …");
  });

  it("shows progress for a request the updater has not picked up yet", () => {
    const banner = updateBanner(
      overview({
        latest: release("0.2.0"),
        requested: { id: "u2", version: "0.2.0", requestedAt: NOW },
      }),
      NOW,
    );
    expect(banner).toMatchObject({ tone: "progress", action: null });
    expect(banner?.text).toContain("0.2.0");
  });

  it("reports a rollback with the reason", () => {
    const banner = updateBanner(
      overview({
        status: status({
          state: "rolledBack",
          message: "Neue Version meldet sich nicht",
          at: NOW - 2 * MIN,
        }),
      }),
      NOW,
    );
    expect(banner).toMatchObject({ tone: "error", action: null });
    expect(banner?.text).toBe(
      "Update auf 0.2.0 fehlgeschlagen und zurückgerollt, 0.1.0 läuft weiter: Neue Version meldet sich nicht",
    );
    expect(banner?.text).toContain("zurückgerollt");
  });

  it("reports a failed update with the reason", () => {
    const banner = updateBanner(
      overview({
        status: status({ state: "failed", message: "Image nicht gefunden" }),
      }),
      NOW,
    );
    expect(banner).toMatchObject({ tone: "error", action: null });
    expect(banner?.text).toBe(
      "Update auf 0.2.0 fehlgeschlagen: Image nicht gefunden",
    );
  });

  it("keeps the error visible while the failed release is still the offer", () => {
    // After a rollback the old version runs, so the release that just failed
    // is still "newer" — the error must not be hidden behind the offer.
    const banner = updateBanner(
      overview({
        latest: release("0.2.0"),
        status: status({ state: "rolledBack", message: "x", at: NOW - MIN }),
      }),
      NOW,
    );
    expect(banner?.tone).toBe("error");
  });

  it("prefers a newer release over the error of an older attempt", () => {
    const banner = updateBanner(
      overview({
        latest: release("0.2.1"),
        status: status({ state: "failed", message: "x", at: NOW - MIN }),
      }),
      NOW,
    );
    expect(banner).toMatchObject({ tone: "info", action: "update" });
    expect(banner?.text).toContain("Version 0.2.1 verfügbar");
  });

  it("lets an old failure fade after ten minutes", () => {
    const banner = updateBanner(
      overview({
        status: status({ state: "failed", message: "x", at: NOW - 11 * MIN }),
      }),
      NOW,
    );
    expect(banner).toBeNull();
  });

  it("stays quiet when there is nothing to say", () => {
    expect(updateBanner(overview({ latest: release("0.1.0") }), NOW)).toBeNull();
    expect(updateBanner(overview({ latest: release("0.0.9") }), NOW)).toBeNull();
    expect(updateBanner(overview(), NOW)).toBeNull();
    expect(
      updateBanner(overview({ status: status({ state: "done" }) }), NOW),
    ).toBeNull();
  });

  it("stays quiet when update checks are switched off", () => {
    const banner = updateBanner(
      overview({ enabled: false, latest: release("0.2.0") }),
      NOW,
    );
    expect(banner).toBeNull();
  });

  it("does not throw on a current version that is not X.Y.Z", () => {
    const banner = updateBanner(
      overview({ current: "dev", latest: release("0.2.0") }),
      NOW,
    );
    expect(banner).toBeNull();
  });
});
