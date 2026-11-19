/**
 * Five-field cron (minute hour day-of-month month day-of-week) in local time. Supports *, lists,
 * ranges and steps, which is what routine schedules need.
 */
type Field = ReadonlySet<number>;
export type Cron = {
  minute: Field;
  hour: Field;
  day: Field;
  month: Field;
  weekday: Field;
  anyDay: boolean;
  anyWeekday: boolean;
};

const RANGES: ReadonlyArray<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(text: string, [low, high]: [number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in "${text}".`);
    let from = low;
    let to = high;
    if (range !== "*") {
      const [start, end] = (range ?? "").split("-").map(Number);
      if (start === undefined || !Number.isInteger(start)) throw new Error(`Bad value in "${text}".`);
      from = start;
      to = end === undefined ? (stepText === undefined ? start : high) : end;
    }
    if (from < low || to > high || from > to) throw new Error(`"${text}" is out of range.`);
    for (let value = from; value <= to; value += step) out.add(value);
  }
  return out;
}

export function parseCron(text: string): Cron {
  const fields = text.trim().split(/\s+/u);
  if (fields.length !== 5) throw new Error("A schedule has five parts: minute hour day month weekday.");
  const [minute, hour, day, month, weekday] = fields.map((field, index) =>
    parseField(field, RANGES[index] as [number, number]),
  );
  // Sunday is 0 or 7.
  if (weekday?.has(7)) weekday.add(0);
  return {
    minute: minute as Field,
    hour: hour as Field,
    day: day as Field,
    month: month as Field,
    weekday: weekday as Field,
    anyDay: fields[2] === "*",
    anyWeekday: fields[4] === "*",
  };
}

export function cronMatches(cron: Cron, at: Date): boolean {
  if (!cron.minute.has(at.getMinutes()) || !cron.hour.has(at.getHours()) || !cron.month.has(at.getMonth() + 1))
    return false;
  const day = cron.day.has(at.getDate());
  const weekday = cron.weekday.has(at.getDay());
  // Standard cron: when both day fields are set, either one matching is enough.
  if (cron.anyDay) return weekday;
  if (cron.anyWeekday) return day;
  return day || weekday;
}

/** The latest slot in (after, until], or undefined. Missed slots collapse into this one run. */
export function latestSlot(cron: Cron, after: Date, until: Date): Date | undefined {
  const cursor = new Date(until);
  cursor.setSeconds(0, 0);
  const floor = Math.max(after.getTime(), until.getTime() - 8 * 24 * 60 * 60_000);
  while (cursor.getTime() > floor) {
    if (cronMatches(cron, cursor)) return new Date(cursor);
    cursor.setMinutes(cursor.getMinutes() - 1);
  }
  return undefined;
}

/** The next slot after a time, within a year, for showing "next run". */
export function nextSlot(cron: Cron, after: Date): Date | undefined {
  const cursor = new Date(after);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = after.getTime() + 366 * 24 * 60 * 60_000;
  while (cursor.getTime() <= limit) {
    if (cronMatches(cron, cursor)) return cursor;
    // Skip whole hours that cannot match.
    if (!cron.hour.has(cursor.getHours())) cursor.setHours(cursor.getHours() + 1, 0);
    else cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return undefined;
}

export function isValidCron(text: string): boolean {
  try {
    parseCron(text);
    return true;
  } catch {
    return false;
  }
}
