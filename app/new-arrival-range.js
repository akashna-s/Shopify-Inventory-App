function dateString(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function monthString(date) {
  return dateString(date).slice(0, 7);
}

function shiftMonth(month, offset) {
  const [year, value] = month.split("-").map(Number);
  return monthString(new Date(year, value - 1 + offset, 1));
}

function startOfWeek(value) {
  const date = new Date(`${value}T00:00:00`);
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + mondayOffset);
  return dateString(date);
}

export function normalizeNewArrivalRange(input, now = new Date()) {
  const url =
    input instanceof URL
      ? input
      : new URL(String(input || ""), "https://secondlook.local");
  const yesterdayDate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
  );
  const yesterday = dateString(yesterdayDate);
  const currentMonth = monthString(yesterdayDate);
  const earliestMonth = shiftMonth(currentMonth, -17);
  const earliest = `${earliestMonth}-01`;
  const classification =
    url.searchParams.get("classification") === "tag" ? "tag" : "type";
  const interval =
    url.searchParams.get("interval") === "week" ? "week" : "month";
  const currentWeekStart = new Date(`${startOfWeek(yesterday)}T00:00:00`);
  currentWeekStart.setDate(currentWeekStart.getDate() - 5 * 7);
  const defaultStart =
    interval === "week"
      ? dateString(currentWeekStart)
      : `${shiftMonth(currentMonth, -14)}-01`;
  const valid = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || "");
  let start = valid(url.searchParams.get("start"))
    ? url.searchParams.get("start")
    : defaultStart;
  let end = valid(url.searchParams.get("end"))
    ? url.searchParams.get("end")
    : yesterday;
  start = start < earliest ? earliest : start > yesterday ? yesterday : start;
  end = end > yesterday ? yesterday : end < earliest ? earliest : end;
  if (start > end) [start, end] = [end, start];
  return {
    start,
    end,
    startMonth: start.slice(0, 7),
    endMonth: end.slice(0, 7),
    earliest,
    earliestMonth,
    currentMonth,
    yesterday,
    classification,
    interval,
  };
}
