/**
 * How much an answer shows of how it was made. `standard` shows the approach over the answer, its
 * steps and search words; `detailed` adds the search strings for each step, hit counts and times.
 */
export const displayLevels = ['standard', 'detailed'] as const;

export type DisplayLevel = (typeof displayLevels)[number];

/** For a host reading a stored choice: anything else is no choice, so the level stays `standard`. */
export const isDisplayLevel = (value: unknown): value is DisplayLevel =>
  displayLevels.some((level) => level === value);
