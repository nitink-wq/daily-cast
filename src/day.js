// Daily boundary helpers. The product day is the calendar day in IST
// (Asia/Kolkata) regardless of which pod/region serves the request, so
// attempts, earnings and expiry all roll over at the same moment for
// every user and every pod.
const DAY_TZ = process.env.DAY_TZ || 'Asia/Kolkata';

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: DAY_TZ }); // YYYY-MM-DD
const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: DAY_TZ, weekday: 'long' });

export function todayKey(date = new Date()) {
  return dayFmt.format(date);
}

export function weekdayName(date = new Date()) {
  return weekdayFmt.format(date);
}
