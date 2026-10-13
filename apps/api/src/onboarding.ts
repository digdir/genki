import type { Principal } from '@genai/contracts';
import type { Context } from 'hono';
import { actorOf, type AdminHandler, type AdminOutcome } from './admin.js';
import { appendVersion, serialized, type ConfigEntry } from './config-store.js';
import { orgNumberValid } from './extensions.js';
import { actorNameOf, changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import type { PlatformModuleFactory } from './platform-modules.js';
import { rightsOf } from './rights.js';

export const onboardingKind = 'onboarding-request';
export const termsVersion = 'utkast';

export type OnboardingStatus = 'pending' | 'approved' | 'rejected';

export interface OnboardingRequest {
  id: string;
  org: string;
  orgName: string;
  contactName: string;
  contactEmail: string;
  purpose: string;
  terms: { accepted: true; version: string; at: string };
  requestedBy: string;
  requester: string;
  requesterName?: string;
  requestedAt: string;
  status: OnboardingStatus;
  decision?: { by: string; byName?: string; at: string; reason: string };
}

export interface OnboardingOptions {
  now?: () => Date;
  newId?: () => string;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409,
  title: string,
  errors: { path: string; message: string }[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const failed = (target: string, path: string, message: string): AdminOutcome => ({
  ok: false,
  errors: [{ path, message }],
  target,
});

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export const mayRequestAccess = (principal: Principal, org: string) =>
  principal.kind === 'employee' &&
  (principal.tenant === org || (principal.authorizedFor?.some((a) => a.org === org) ?? false)) &&
  rightsOf(principal, org).has('manage-services');

const ownView = (request: OnboardingRequest) =>
  Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'requester'));

const operatorView = (request: OnboardingRequest, tenantName?: string) => ({
  id: request.id,
  org: request.org,
  orgName: tenantName ?? request.orgName,
  contactName: request.contactName,
  contactEmail: request.contactEmail,
  purpose: request.purpose,
  requestedBy: request.requestedBy,
  ...(request.requesterName ? { requesterName: request.requesterName } : {}),
  requestedAt: request.requestedAt,
  status: request.status,
  terms: request.terms,
  ...(request.decision ? { decision: request.decision } : {}),
});

export const createOnboardingModule =
  (options: OnboardingOptions = {}): PlatformModuleFactory =>
  (deps) => {
    const now = options.now ?? (() => new Date());
    const newId = options.newId ?? (() => crypto.randomUUID());
    const writes = serialized();

    const all = async () =>
      (await deps.configEntries.latest({ kind: onboardingKind }))
        .filter((e) => !e.deleted)
        .map((e) => e as ConfigEntry<OnboardingRequest>)
        .sort((a, b) => b.spec.requestedAt.localeCompare(a.spec.requestedAt));

    const handlers: Record<string, AdminHandler> = {
      'platform.onboarding.request': (input, principal) =>
        writes(async () => {
          const org = text(input.org);
          const target = `onboarding:${org}`;
          if (!mayRequestAccess(principal, org))
            return failed(target, 'principal', 'only a leader of the organisation asks for access');
          if ((await all()).some((e) => e.spec.org === org && e.spec.status === 'pending'))
            return failed(target, 'status', 'the organisation already has a pending request');
          const at = now().toISOString();
          const request: OnboardingRequest = {
            id: newId(),
            org,
            orgName: text(input.orgName),
            contactName: text(input.contactName),
            contactEmail: text(input.contactEmail),
            purpose: text(input.purpose),
            terms: { accepted: true, version: termsVersion, at },
            requestedBy: text(input.contactName),
            requester: actorOf(principal),
            ...(text(input.requesterName) ? { requesterName: text(input.requesterName) } : {}),
            requestedAt: at,
            status: 'pending',
          };
          await appendVersion(deps.configEntries, {
            kind: onboardingKind,
            scope: org,
            id: request.id,
            spec: request,
            deleted: false,
            by: request.requester,
            reason: input.reason,
            at,
          });
          return {
            ok: true,
            value: request,
            target: `${target}/${request.id}`,
            audit: { scope: 'platform', org, terms: request.terms },
          };
        }),
      'platform.onboarding.decide': (input, principal) =>
        writes(async () => {
          const id = String(input.id ?? '');
          const target = `onboarding-request:${id}`;
          if (principal.kind !== 'operator')
            return failed(target, 'principal', 'only operators decide access requests');
          const entry = (await all()).find((e) => e.id === id);
          if (!entry) return failed(target, 'request', `no access request ${id}`);
          if (entry.spec.status !== 'pending')
            return failed(target, 'status', `the request is already ${entry.spec.status}`);
          const at = now().toISOString();
          const decided: OnboardingRequest = {
            ...entry.spec,
            status: input.approve === true ? 'approved' : 'rejected',
            decision: {
              by: actorOf(principal),
              ...(typeof input.byName === 'string' && input.byName ? { byName: input.byName } : {}),
              at,
              reason: input.reason,
            },
          };
          await appendVersion(deps.configEntries, {
            kind: onboardingKind,
            scope: entry.scope,
            id,
            spec: decided,
            deleted: false,
            by: actorOf(principal),
            reason: input.reason,
            at,
          });
          return {
            ok: true,
            value: decided,
            target,
            audit: { scope: 'platform', org: decided.org, after: { status: decided.status } },
          };
        }),
    };

    return {
      id: 'onboarding',
      handlers,
      mount: (app, mounted) => {
        const reasonOf = (c: Context) => (changeReasonOf(c) ?? '').trim();
        const body = async (c: Context) =>
          (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        const operator = async (c: Context) => {
          const principal = await mounted.authenticate(c.req.raw);
          if (!principal) return { response: problem(c, 401, 'Unauthorized') };
          if (principal.kind !== 'operator') return { response: problem(c, 403, 'Forbidden') };
          return { principal: { ...principal, tenant: deps.platformTenant } };
        };
        const registered = async (org: string) =>
          org === deps.platformTenant || (await mounted.admin.tenantNames()).has(org);

        app.post('/onboarding/requests', async (c) => {
          const principal = await mounted.authenticate(c.req.raw);
          if (!principal) return problem(c, 401, 'Unauthorized');
          const input = await body(c);
          const org = text(input.org);
          const errors: { path: string; message: string }[] = [];
          if (!orgNumberValid(org))
            errors.push({ path: 'org', message: 'Organisasjonsnummeret er ikke gyldig.' });
          for (const field of ['orgName', 'contactName', 'purpose'] as const)
            if (!text(input[field])) errors.push({ path: field, message: 'Feltet må fylles ut.' });
          if (!emailPattern.test(text(input.contactEmail)))
            errors.push({ path: 'contactEmail', message: 'E-postadressen er ikke gyldig.' });
          if (input.acceptedTerms !== true)
            errors.push({ path: 'acceptedTerms', message: 'Vilkårene må godtas.' });
          if (errors.length > 0) return problem(c, 400, 'Invalid request', errors);
          if (!mayRequestAccess(principal, org))
            return problem(
              c,
              403,
              'Du må være daglig leder eller ha tilgangspakken for KI-administrasjon i virksomheten',
            );
          if (await registered(org))
            return problem(c, 409, 'Virksomheten er allerede registrert', [
              { path: 'org', message: 'already registered' },
            ]);
          const result = await mounted.admin.perform<OnboardingRequest>(
            principal,
            'platform.onboarding.request',
            {
              tenant: org,
              reason: `Søknad om tilgang for ${org}`,
              org,
              orgName: input.orgName,
              contactName: input.contactName,
              contactEmail: input.contactEmail,
              purpose: input.purpose,
              requesterName: actorNameOf(c),
            },
          );
          c.header('genai-task', result.task);
          if (result.ok) return c.json({ id: result.value.id, status: result.value.status }, 201);
          if (result.errors.some((e) => e.path === 'status'))
            return problem(
              c,
              409,
              'Virksomheten har allerede en søknad til behandling',
              result.errors,
            );
          return problem(c, 403, 'Forbidden', result.errors);
        });

        app.get('/onboarding/requests/mine', async (c) => {
          const principal = await mounted.authenticate(c.req.raw);
          if (!principal) return problem(c, 401, 'Unauthorized');
          const me = actorOf(principal);
          return c.json({
            data: (await all()).filter((e) => e.spec.requester === me).map((e) => ownView(e.spec)),
          });
        });

        app.get('/onboarding/organisations/:org', async (c) => {
          const principal = await mounted.authenticate(c.req.raw);
          if (!principal) return problem(c, 401, 'Unauthorized');
          const org = c.req.param('org') ?? '';
          const actsFor =
            principal.kind === 'employee' &&
            (principal.tenant === org ||
              (principal.authorizedFor?.some((a) => a.org === org) ?? false));
          if (!actsFor) return problem(c, 403, 'Forbidden');
          const me = actorOf(principal);
          const pending = (await all()).find(
            (e) => e.spec.org === org && e.spec.status === 'pending',
          );
          return c.json({
            org,
            registered: await registered(org),
            mayRequest: mayRequestAccess(principal, org),
            pendingRequest: pending
              ? { requestedAt: pending.spec.requestedAt, mine: pending.spec.requester === me }
              : null,
          });
        });

        app.get('/operator/onboarding/requests', async (c) => {
          const guard = await operator(c);
          if ('response' in guard) return guard.response;
          const status = c.req.query('status');
          const names = await mounted.admin.tenantNames();
          return c.json({
            data: (await all())
              .filter((e) => !status || e.spec.status === status)
              .map((e) => operatorView(e.spec, names.get(e.spec.org))),
          });
        });

        app.post('/operator/onboarding/requests/:id/decision', async (c) => {
          const guard = await operator(c);
          if ('response' in guard) return guard.response;
          const input = await body(c);
          const reason = reasonOf(c);
          if (typeof input.approve !== 'boolean')
            return problem(c, 400, 'Invalid request', [
              { path: 'approve', message: 'approve must be true or false' },
            ]);
          if (!isReasonLongEnough(reason))
            return problem(c, 400, 'Invalid request', [
              { path: 'change-reason', message: reasonTooShort },
            ]);
          const id = c.req.param('id') ?? '';
          const found = (await all()).find((e) => e.id === id);
          if (!found) return problem(c, 404, 'Not found');
          if (found.spec.status !== 'pending')
            return problem(c, 409, 'Conflict', [
              { path: 'status', message: `the request is already ${found.spec.status}` },
            ]);
          if (input.approve && !(await registered(found.spec.org))) {
            const created = await mounted.admin.perform(guard.principal, 'platform.tenant.create', {
              tenant: found.spec.org,
              orgNumber: found.spec.org,
              name: found.spec.orgName,
              reason,
            });
            if (!created.ok) return problem(c, 400, 'Invalid request', created.errors);
          }
          const result = await mounted.admin.perform<OnboardingRequest>(
            guard.principal,
            'platform.onboarding.decide',
            {
              tenant: deps.platformTenant,
              id,
              approve: input.approve,
              reason,
              byName: actorNameOf(c),
            },
          );
          c.header('genai-task', result.task);
          if (!result.ok)
            return problem(
              c,
              result.errors.some((e) => e.path === 'status') ? 409 : 400,
              'Invalid request',
              result.errors,
            );
          return c.json(operatorView(result.value));
        });
      },
    };
  };

export const onboardingModule: PlatformModuleFactory = createOnboardingModule();
