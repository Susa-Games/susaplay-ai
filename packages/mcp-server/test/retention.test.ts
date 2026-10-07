import { describe, expect, it } from "vitest";

import { retentionForecast } from "../src/tools/games.js";

const now = Date.parse("2026-10-07T12:00:00Z");
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
const policy = { maxVersionsPerPlatform: 3, minAgeHours: 24, maxPendingPerGame: 3 };

describe("retentionForecast", () => {
  it("counts the new upload as one of the kept builds", () => {
    const forecast = retentionForecast(
      [
        { versionId: "1.0.3", status: "pending_review", uploadedAt: daysAgo(1) },
        { versionId: "1.0.2", status: "live", uploadedAt: daysAgo(5) },
        { versionId: "1.0.1", status: "deprecated", uploadedAt: daysAgo(9) },
        { versionId: "1.0.0", status: "deprecated", uploadedAt: daysAgo(20) },
      ],
      policy,
      "1.0.2",
      now,
    );
    // Keep 3 = the new build + 1.0.3 + 1.0.2; the two older deprecated ones go.
    expect(forecast.deletedByNextUpload).toEqual(["1.0.1", "1.0.0"]);
  });

  it("deletes failed builds whatever their age, and spares live, in-flight and young ones", () => {
    const forecast = retentionForecast(
      [
        { versionId: "2.0.0", status: "failed", uploadedAt: daysAgo(0.01) },
        { versionId: "1.0.4", status: "processing", uploadedAt: daysAgo(0.02) },
        { versionId: "1.0.3", status: "rejected", uploadedAt: daysAgo(0.3) },
        // Past the keep window from here on.
        { versionId: "1.0.2", status: "deprecated", uploadedAt: daysAgo(0.5) },
        { versionId: "1.0.1", status: "live", uploadedAt: daysAgo(30) },
        { versionId: "1.0.0", status: "deprecated", uploadedAt: daysAgo(40) },
        { versionId: "0.9.0", status: "deprecated", platform: "android", uploadedAt: daysAgo(90) },
      ],
      policy,
      "1.0.1",
      now,
    );
    expect(forecast.deletedByNextUpload).toEqual(["2.0.0", "1.0.0"]);
    expect(forecast.protectedByGracePeriod).toEqual([
      { versionId: "1.0.2", deletableFrom: new Date(Date.parse(daysAgo(0.5)) + 86_400_000).toISOString() },
    ]);
  });
});
