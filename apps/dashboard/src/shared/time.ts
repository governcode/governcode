// Times in words, as the Allowance and the Overview show them. Pure: `now` is passed in so the
// tests can fix it; local time, as the person reading it lives in it.

/** How long ago: "40 s ago", "12 min ago", "3 h ago". A time in the future reads as "0 s ago". */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

/** A time to come, in words: "14:20", "tomorrow 09:10", "Thu 14:00" or "12 Oct 14:00". */
export function when(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;   // a vendor's own text, shown as given
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  return days <= 0 ? hm : days === 1 ? `tomorrow ${hm}` : days < 7 ? `${d.toLocaleDateString([], { weekday: "short" })} ${hm}`
    : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${hm}`;
}

/** How long until: "in 25 min", "in 3 h 5 min", "in 4 days". A time already past reads as "in 0 min". */
export function until(iso: string, now = Date.now()): string {
  const m = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  return m < 60 ? `in ${m} min` : m < 48 * 60 ? `in ${Math.floor(m / 60)} h ${m % 60} min` : `in ${Math.round(m / 1440)} days`;
}
