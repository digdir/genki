/** In lockdown a run's jobs stop 24 hours after it was admitted; the portal warns in the last 4. */
export const admissionWarningMs = 4 * 3_600_000;

export const admissionRunsOutSoon = (runsOutAt: string, now = Date.now()) =>
  Date.parse(runsOutAt) - now < admissionWarningMs;
