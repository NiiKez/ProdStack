/**
 * Format an ISO timestamp as a local `HH:MM:SS` clock for the runtime-log
 * gutter. Returns a stable placeholder for unparseable input so the viewport
 * never renders "Invalid Date".
 */
export function formatLogClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
