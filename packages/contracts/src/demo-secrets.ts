const tokenChars = /[A-Za-z0-9_+=-]+/g;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const looksLikeSecret = (token: string) => {
  if (/^(sk|xi|gp|ghp|github_pat)_[A-Za-z0-9_-]{16,}$/.test(token)) return true;
  if (token.length < 32 || token.length > 512 || uuid.test(token)) return false;
  if (/[a-z]{12,}/.test(token)) return false;
  const digits = token.replace(/[^0-9]/g, '').length;
  const lower = token.replace(/[^a-z]/g, '').length;
  const upper = token.replace(/[^A-Z]/g, '').length;
  if (lower >= 4 && upper >= 4 && digits >= 2) return true;
  return digits >= 6 && lower + upper >= 6;
};

export const secretPathIn = (value: unknown, path = ''): string | undefined => {
  if (typeof value === 'string')
    return (value.match(tokenChars) ?? []).some(looksLikeSecret) ? path || '.' : undefined;
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const found = secretPathIn(item, path ? `${path}.${i}` : String(i));
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      const found =
        secretPathIn(key, path ? `${path}.${key}` : key) ??
        secretPathIn(item, path ? `${path}.${key}` : key);
      if (found) return found;
    }
  return undefined;
};
