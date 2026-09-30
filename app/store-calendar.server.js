function validTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function normalizeIanaTimeZone(timeZone) {
  const value = String(timeZone || "").trim();
  if (!value) return "Etc/UTC";
  if (!validTimeZone(value)) throw new Error(`Invalid IANA timezone: ${value}`);
  return value;
}

export function calendarDateInTimeZone(instant, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeIanaTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function shiftCalendarDate(date, days) {
  const [year, month, day] = String(date).split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

export function latestCompletedDate(instant, timeZone) {
  return shiftCalendarDate(calendarDateInTimeZone(instant, timeZone), -1);
}

export function shiftCalendarMonth(month, offset) {
  const [year, value] = String(month).split("-").map(Number);
  return new Date(Date.UTC(year, value - 1 + offset, 1)).toISOString().slice(0, 7);
}

export function latestSyncMonths(instant, timeZone, count = 18) {
  const newest = latestCompletedDate(instant, timeZone).slice(0, 7);
  return Array.from({ length: count }, (_, index) => shiftCalendarMonth(newest, -index));
}

export function storeMonthBounds(month, instant, timeZone) {
  const [year, value] = String(month).split("-").map(Number);
  const naturalEnd = new Date(Date.UTC(year, value, 0)).toISOString().slice(0, 10);
  const completedThrough = latestCompletedDate(instant, timeZone);
  return {
    start: `${month}-01`,
    end: naturalEnd < completedThrough ? naturalEnd : completedThrough,
  };
}
