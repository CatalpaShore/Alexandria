import { describe, expect, it } from "vitest";
import {
  getHourInTimeZone,
  getMediaWorkerScheduleState,
  isHourInWindow,
  selectMediaWorkerJobTypes
} from "../../server/src/mediaWorkerPolicy";

const schedule = {
  timeZone: "Asia/Shanghai",
  nightStartHour: 1,
  nightEndHour: 7,
  daytimeCooldownMs: 30 * 60 * 1000
};

describe("media worker schedule policy", () => {
  it("partitions dedicated highlight work from the existing media worker", () => {
    const types = ["probe", "highlight", "subtitle", "subtitle-translate"];
    expect(selectMediaWorkerJobTypes(types, "highlight")).toEqual(["highlight"]);
    expect(selectMediaWorkerJobTypes(types, "", "highlight")).toEqual(["probe", "subtitle", "subtitle-translate"]);
    expect(selectMediaWorkerJobTypes(types)).toEqual(types);
  });
  it("never claims an unregistered handler and applies exclusions after selection", () => {
    expect(selectMediaWorkerJobTypes(["highlight"], " highlight, unknown ", "highlight")).toEqual([]);
  });
  it("keeps the configured late-night window active until the end hour", () => {
    expect(isHourInWindow(0, 1, 7)).toBe(false);
    expect(isHourInWindow(1, 1, 7)).toBe(true);
    expect(isHourInWindow(6, 1, 7)).toBe(true);
    expect(isHourInWindow(7, 1, 7)).toBe(false);
  });

  it("supports a night window that crosses midnight", () => {
    expect(isHourInWindow(23, 22, 6)).toBe(true);
    expect(isHourInWindow(3, 22, 6)).toBe(true);
    expect(isHourInWindow(12, 22, 6)).toBe(false);
  });

  it("treats equal start and end hours as an all-day window", () => {
    expect(isHourInWindow(0, 4, 4)).toBe(true);
    expect(isHourInWindow(16, 4, 4)).toBe(true);
  });

  it("evaluates hours in the configured timezone instead of the host timezone", () => {
    const utc = new Date("2026-08-02T18:30:00.000Z");
    expect(getHourInTimeZone(utc, "Asia/Shanghai")).toBe(2);
    expect(getHourInTimeZone(utc, "UTC")).toBe(18);
  });

  it("runs continuously at night and rate-limits daytime background starts", () => {
    const daytimeNow = Date.parse("2026-08-02T04:00:00.000Z"); // 12:00 in Shanghai
    expect(getMediaWorkerScheduleState(daytimeNow, daytimeNow - 5 * 60 * 1000, schedule)).toMatchObject({
      nightWindowActive: false,
      daytimeBackgroundDue: false,
      backgroundAllowed: false
    });
    expect(getMediaWorkerScheduleState(daytimeNow, daytimeNow - 31 * 60 * 1000, schedule)).toMatchObject({
      nightWindowActive: false,
      daytimeBackgroundDue: true,
      backgroundAllowed: true
    });

    const nightNow = Date.parse("2026-08-01T18:00:00.000Z"); // 02:00 in Shanghai
    expect(getMediaWorkerScheduleState(nightNow, nightNow, schedule)).toMatchObject({
      nightWindowActive: true,
      backgroundAllowed: true
    });
  });
});
