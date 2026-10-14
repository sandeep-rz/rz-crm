/** Evaluate a local business-hours window against an absolute instant. */
export function isWithinTimeWindow(
  operand: string,
  timezone: string,
  now = new Date()
): boolean {
  const match = operand
    .trim()
    .match(/^(\d{2}):(\d{2})\s*[-–—]\s*(\d{2}):(\d{2})$/);
  if (!match) throw new Error('Invalid automation time window');
  const [fromHour, fromMinute, toHour, toMinute] = match.slice(1).map(Number);
  if (fromHour > 23 || toHour > 23 || fromMinute > 59 || toMinute > 59) {
    throw new Error('Invalid automation time window');
  }
  // Explicit timezone + h23 prevents the host timezone and midnight-as-24
  // from changing which branch runs. Intl also handles daylight saving time.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const minutes =
    Number(parts.find((p) => p.type === 'hour')?.value) * 60 +
    Number(parts.find((p) => p.type === 'minute')?.value);
  const from = fromHour * 60 + fromMinute;
  const to = toHour * 60 + toMinute;
  return from <= to
    ? minutes >= from && minutes < to
    : minutes >= from || minutes < to;
}
