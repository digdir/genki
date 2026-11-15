/** In lockdown, a knowledge run's jobs work this long after the API admitted it (ADR 0033, ADR 0042). */
export const admissionHours = 24;

/** When a run admitted at `admittedAt` stops being admitted in lockdown. */
export const admissionRunsOutAt = (admittedAt: string) =>
  new Date(Date.parse(admittedAt) + admissionHours * 3_600_000).toISOString();
