import { useEffect, useMemo, useRef, useState } from "react";

/* Report pages provide validated ISO dates. */
/* eslint-disable react/prop-types */

const isoDate = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const asDate = (value) => new Date(`${value}T00:00:00`);
const firstOfMonth = (value) => {
  const date = typeof value === "string" ? asDate(value) : value;
  return new Date(date.getFullYear(), date.getMonth(), 1);
};
const MONTHS = Array.from({ length: 12 }, (_, month) =>
  new Date(2024, month, 1).toLocaleDateString("en-US", { month: "short" }),
);
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function readable(value) {
  return asDate(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function sameMonth(left, right) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth()
  );
}

function clampMonth(date, min, max) {
  const value = firstOfMonth(date);
  const earliest = firstOfMonth(min);
  const latest = firstOfMonth(max);
  return value < earliest ? earliest : value > latest ? latest : value;
}

function calendarDays(viewDate) {
  const first = firstOfMonth(viewDate);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    return date;
  });
}

function CalendarPanel({
  label,
  value,
  viewDate,
  min,
  max,
  rangeStart,
  rangeEnd,
  onChange,
  onViewChange,
  previous,
  next,
}) {
  const [mode, setMode] = useState("date");
  const days = useMemo(() => calendarDays(viewDate), [viewDate]);
  const firstYear = asDate(min).getFullYear();
  const lastYear = asDate(max).getFullYear();
  const years = [];
  for (let year = firstYear; year <= lastYear; year++) years.push(year);

  useEffect(() => setMode("date"), [value]);

  const chooseYear = (year) => {
    onViewChange(clampMonth(new Date(year, viewDate.getMonth(), 1), min, max));
    setMode("month");
  };
  const chooseMonth = (month) => {
    onViewChange(
      clampMonth(new Date(viewDate.getFullYear(), month, 1), min, max),
    );
    setMode("date");
  };

  return (
    <section className="report-calendar-panel" aria-label={`${label} calendar`}>
      <div className="report-calendar-panel-label">
        <span>{label}</span>
        <strong>{readable(value)}</strong>
      </div>
      <div className="report-calendar-toolbar">
        {previous ? (
          <button type="button" aria-label="Previous month" onClick={previous}>
            ‹
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          className="report-calendar-period"
          aria-label="Choose year and month"
          onClick={() => setMode(mode === "date" ? "year" : "date")}
        >
          {mode === "year"
            ? "Select year"
            : mode === "month"
              ? `${viewDate.getFullYear()} · Select month`
              : `${MONTHS[viewDate.getMonth()]} ${viewDate.getFullYear()}`}
          <span aria-hidden="true">⌄</span>
        </button>
        {next ? (
          <button type="button" aria-label="Next month" onClick={next}>
            ›
          </button>
        ) : (
          <span />
        )}
      </div>

      {mode === "year" ? (
        <div className="report-calendar-years">
          {years.map((year) => (
            <button
              type="button"
              key={year}
              className={year === viewDate.getFullYear() ? "selected" : ""}
              onClick={() => chooseYear(year)}
            >
              {year}
            </button>
          ))}
        </div>
      ) : mode === "month" ? (
        <div className="report-calendar-months">
          {MONTHS.map((month, index) => {
            const candidate = new Date(viewDate.getFullYear(), index, 1);
            const unavailable =
              candidate < firstOfMonth(min) || candidate > firstOfMonth(max);
            return (
              <button
                type="button"
                key={month}
                disabled={unavailable}
                className={index === viewDate.getMonth() ? "selected" : ""}
                onClick={() => chooseMonth(index)}
              >
                {month}
              </button>
            );
          })}
        </div>
      ) : (
        <>
          <div className="report-calendar-weekdays" aria-hidden="true">
            {WEEKDAYS.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="report-calendar-grid">
            {days.map((date) => {
              const dateValue = isoDate(date);
              const unavailable = dateValue < min || dateValue > max;
              const outside = !sameMonth(date, viewDate);
              const endpoint =
                dateValue === rangeStart || dateValue === rangeEnd;
              const inRange = dateValue > rangeStart && dateValue < rangeEnd;
              return (
                <button
                  type="button"
                  key={dateValue}
                  disabled={unavailable}
                  className={`${outside ? "outside" : ""} ${inRange ? "in-range" : ""} ${endpoint ? "endpoint" : ""}`}
                  aria-label={`${label}: ${readable(dateValue)}`}
                  onClick={() => onChange(dateValue)}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

export default function DateRangePicker({
  start,
  end,
  min,
  max,
  onApply,
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [draftStart, setDraftStart] = useState(start);
  const [draftEnd, setDraftEnd] = useState(end);
  const [startView, setStartView] = useState(() => firstOfMonth(start));
  const [endView, setEndView] = useState(() => firstOfMonth(end));
  const rootRef = useRef(null);

  const resetDraft = () => {
    setDraftStart(start);
    setDraftEnd(end);
    setStartView(firstOfMonth(start));
    setEndView(firstOfMonth(end));
  };

  useEffect(() => {
    if (open) return;
    resetDraft();
    // Values are synchronized after a completed route navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, open]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const moveStartMonth = (offset) =>
    setStartView((current) =>
      clampMonth(
        new Date(current.getFullYear(), current.getMonth() + offset, 1),
        min,
        max,
      ),
    );
  const moveEndMonth = (offset) =>
    setEndView((current) =>
      clampMonth(
        new Date(current.getFullYear(), current.getMonth() + offset, 1),
        min,
        max,
      ),
    );

  return (
    <div className="report-range-picker" ref={rootRef}>
      <button
        type="button"
        className="report-range-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (!open) resetDraft();
          setOpen((current) => !current);
        }}
      >
        <span className="report-range-calendar-icon" aria-hidden="true">
          ▣
        </span>
        <span>
          {readable(start)} – {readable(end)}
        </span>
        <span className="report-range-chevron" aria-hidden="true">
          ⌄
        </span>
      </button>

      {open && (
        <div
          className="report-range-popover"
          role="dialog"
          aria-label="Select date range"
        >
          <div className="report-range-calendars">
            <CalendarPanel
              label="Start date"
              value={draftStart}
              viewDate={startView}
              min={min}
              max={max}
              rangeStart={draftStart}
              rangeEnd={draftEnd}
              previous={() => moveStartMonth(-1)}
              onViewChange={setStartView}
              onChange={(value) => {
                setDraftStart(value);
                if (value > draftEnd) {
                  setDraftEnd(value);
                  setEndView(firstOfMonth(value));
                }
              }}
            />
            <CalendarPanel
              label="End date"
              value={draftEnd}
              viewDate={endView}
              min={min}
              max={max}
              rangeStart={draftStart}
              rangeEnd={draftEnd}
              next={() => moveEndMonth(1)}
              onViewChange={setEndView}
              onChange={(value) => {
                setDraftEnd(value);
                if (value < draftStart) {
                  setDraftStart(value);
                  setStartView(firstOfMonth(value));
                }
              }}
            />
          </div>
          <div className="report-range-footer">
            <small>
              Available {readable(min)} – {readable(max)}
            </small>
            <div>
              <button
                type="button"
                className="secondary"
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  onApply(draftStart, draftEnd);
                  setOpen(false);
                }}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
