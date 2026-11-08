/** Start of the current day in the given IANA timezone, as an ISO string in UTC. */
export function startOfLocalDay(timezone: string, now = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const h = parts.hour === "24" ? 0 : Number(parts.hour);
  const localSeconds = h * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return new Date(now.getTime() - localSeconds * 1000 - now.getMilliseconds()).toISOString();
}
