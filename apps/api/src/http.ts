import { z } from '@hono/zod-openapi';
import type { Context, HonoRequest } from 'hono';
import type { Principal } from '@genai/contracts';
import type { ValidationError } from '@genai/definitions';

export interface Authenticator {
  authenticate(request: Request): Promise<Principal | undefined>;
}

export const Problem = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .openapi('Problem');

export const problemContent = { 'application/problem+json': { schema: Problem } };

export const problems = {
  400: { content: problemContent, description: 'The request could not be read' },
  401: { content: problemContent, description: 'Not authenticated' },
  403: { content: problemContent, description: 'Not allowed for this tenant' },
  404: { content: problemContent, description: 'Not found' },
  422: { content: problemContent, description: 'The change is invalid' },
} as const;

export const problem = <S extends 400 | 401 | 403 | 404 | 422>(
  c: Context,
  status: S,
  title: string,
  extra: { detail?: string; errors?: ValidationError[] } = {},
) =>
  c.json({ type: 'about:blank', title, status: status as number, ...extra }, status, {
    'content-type': 'application/problem+json',
  });

export const minimumReasonLength = 10;
export const reasonTooShort = `Skriv en begrunnelse på minst ${minimumReasonLength} tegn.`;
export const isReasonLongEnough = (reason: string) => reason.trim().length >= minimumReasonLength;

const decoded = (raw: string) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

export const changeReason = z.object({
  'change-reason': z.string().refine((raw) => isReasonLongEnough(decoded(raw)), reasonTooShort),
});

export const actorNameOf = (c: { req: Pick<HonoRequest, 'header'> }) => {
  const raw = c.req.header('actor-name');
  if (!raw) return undefined;
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    name = raw;
  }
  return name.trim().slice(0, 120) || undefined;
};

export const changeReasonOf = (c: { req: Pick<HonoRequest, 'header'> }) => {
  const raw = c.req.header('change-reason');
  return raw === undefined ? undefined : decoded(raw);
};
