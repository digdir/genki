const osloDay = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', day: 'numeric' });

/** Days of usage to ask for so the report covers this month so far, in Oslo time. */
export const daysThisMonth = (now: Date = new Date()) => Math.max(Number(osloDay.format(now)), 1);

const hourMs = 3_600_000;

/** The failed runs of the last seven days, from the start of the hour so the address stays the same within it. */
export const failedRunsRequest = (now: Date = new Date()) => ({
  status: 'failed',
  from: new Date(Math.floor(now.getTime() / hourMs) * hourMs - 7 * 24 * hourMs).toISOString(),
  limit: 500,
});
