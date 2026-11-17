const osloDay = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', day: 'numeric' });

/** Days of usage to ask for so the report covers this month so far, in Oslo time. */
export const daysThisMonth = (now: Date = new Date()) => Math.max(Number(osloDay.format(now)), 1);
