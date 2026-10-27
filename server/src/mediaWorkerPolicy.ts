export type MediaWorkerScheduleConfig = {
  timeZone: string;
  nightStartHour: number;
  nightEndHour: number;
  daytimeCooldownMs: number;
};

export type MediaWorkerScheduleState = {
  localHour: number;
  nightWindowActive: boolean;
  daytimeBackgroundDue: boolean;
  backgroundAllowed: boolean;
};

export function isHourInWindow(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return true;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

export function getHourInTimeZone(now: Date, timeZone: string): number {
  const hourPart = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hour12: false,
    timeZone
  }).formatToParts(now).find((part) => part.type === "hour")?.value;
  const hour = Number.parseInt(hourPart ?? "", 10);
  return Number.isFinite(hour) ? hour % 24 : now.getHours();
}

export function getMediaWorkerScheduleState(
  nowMs: number,
  lastDaytimeBackgroundStartedAt: number,
  schedule: MediaWorkerScheduleConfig
): MediaWorkerScheduleState {
  const localHour = getHourInTimeZone(new Date(nowMs), schedule.timeZone);
  const nightWindowActive = isHourInWindow(
    localHour,
    schedule.nightStartHour,
    schedule.nightEndHour
  );
  const daytimeBackgroundDue = schedule.daytimeCooldownMs === 0
    || nowMs - lastDaytimeBackgroundStartedAt >= schedule.daytimeCooldownMs;
  return {
    localHour,
    nightWindowActive,
    daytimeBackgroundDue,
    backgroundAllowed: nightWindowActive || daytimeBackgroundDue
  };
}
// Dedicated workers only claim registered handlers in their explicit partition.
export function selectMediaWorkerJobTypes(registered: string[], include = "", exclude = ""): string[] {
  const selected = new Set(include.split(",").map(value => value.trim()).filter(Boolean));
  const excluded = new Set(exclude.split(",").map(value => value.trim()).filter(Boolean));
  return registered.filter(type => (!selected.size || selected.has(type)) && !excluded.has(type));
}

