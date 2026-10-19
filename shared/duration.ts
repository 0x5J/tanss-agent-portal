/**
 * A duration the way people type it. Nobody counts in minutes while working,
 * so "1:30", "1,5h" and "90" all have to land on the same number.
 */
export function parseDuration(raw: string): number | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (!text) return null;

  // 1:30 — hours and minutes
  const clock = /^(\d{1,2}):([0-5]\d)$/.exec(text);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);

  // 1h30, 1h30min, 2h
  const both = /^(\d{1,2})h(?:(\d{1,2})(?:min|m)?)?$/.exec(text);
  if (both) {
    const minutes = both[2] === undefined ? 0 : Number(both[2]);
    if (minutes > 59) return null;
    return Number(both[1]) * 60 + minutes;
  }

  // 1,5h / 1.5 h / 0,25h
  const decimal = /^(\d{1,2})[.,](\d{1,2})h$/.exec(text);
  if (decimal) {
    const hours = Number(`${decimal[1]}.${decimal[2]}`);
    return Math.round(hours * 60);
  }

  // 45min / 45m
  const min = /^(\d{1,4})(?:min|m)$/.exec(text);
  if (min) return Number(min[1]);

  // plain number — minutes, because that is what the field asked for
  const plain = /^(\d{1,4})$/.exec(text);
  if (plain) return Number(plain[1]);

  return null;
}

/** "1:30" — the form a duration is written back in. */
export function formatHm(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}
