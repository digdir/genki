import type { Principal } from '@genai/contracts';
import type { Context } from 'hono';
import type { Admin } from './admin.js';
import { requireRight, rightRefused, type Right } from './rights.js';

export const supportSessionHeader = 'support-session';

export type Access = (
  principal: Principal,
  tenant: string,
  request: Request,
) => Principal | undefined;

export const tenantAccess =
  (admin: Pick<Admin, 'supportSession'>): Access =>
  (principal, tenant, request) => {
    if (principal.kind === 'operator') {
      const id = request.headers.get(supportSessionHeader) ?? undefined;
      return admin.supportSession(id, principal, tenant)
        ? { ...principal, tenant, actor: principal }
        : undefined;
    }
    if (principal.tenant === tenant) return principal;
    if (principal.authorizedFor?.some((a) => a.org === tenant)) return { ...principal, tenant };
    return undefined;
  };

export const refusedRight = (c: Context, principal: Principal, tenant: string, right: Right) => {
  const check = requireRight(principal, tenant, right);
  return check.ok ? undefined : rightRefused(c, check.problem);
};

const tenantProblem = (c: Context, status: 403 | 404, title: string) =>
  c.json({ type: 'about:blank', title, status }, status, {
    'content-type': 'application/problem+json',
  });

export const enterTenant = (
  c: Context,
  access: Access,
  principal: Principal,
  tenant: string,
  right?: Right,
): { principal: Principal } | { response: Response } => {
  const acting = access(principal, tenant, c.req.raw);
  if (!acting) return { response: tenantProblem(c, 404, 'Not found') };
  const lacking = right && refusedRight(c, acting, tenant, right);
  if (lacking) return { response: lacking };
  return { principal: acting };
};
