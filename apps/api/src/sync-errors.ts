const redacted = '[redacted]';
const bearer = /\bBearer\s+[^\s"',;]+/gi;
const tokenLike = /[A-Za-z0-9_\-.+/=]{32,}/g;

export const redactSecrets = (text: string, secrets: readonly string[]) => {
  let out = text;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join(redacted);
  return out.replace(bearer, `Bearer ${redacted}`).replace(tokenLike, redacted);
};
