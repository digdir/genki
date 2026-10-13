const supported = new Set(['i', 's', 'm', 'u']);

export const compilePattern = (pattern: string): RegExp => {
  const match = /^\(\?([a-z]+)\)/.exec(pattern);
  const flags = match?.[1] ?? '';
  for (const flag of flags) {
    if (!supported.has(flag)) throw new Error(`unsupported regex flag ${flag} in ${pattern}`);
  }
  return new RegExp(match ? pattern.slice(match[0].length) : pattern, flags);
};
