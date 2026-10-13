import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'genai-signature';

export const signWebhook = (secret: string, timestamp: number, body: string) =>
  `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

export const verifyWebhookSignature = (
  secret: string,
  header: string,
  body: string,
  now: Date = new Date(),
  toleranceSeconds = 300,
) => {
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=', 2) as [string, string]),
  );
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !parts.v1) return false;
  if (Math.abs(now.getTime() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, body).split('v1=')[1] ?? '', 'hex');
  const given = Buffer.from(parts.v1, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
};

export const webhookSecretRef = (tenant: string, name: string) =>
  `secret://tenant/${tenant}/${name}`;
