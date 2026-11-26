import type { Principal } from '@genai/contracts';
import { isApiKeyPrincipal } from '@genai/identity';
import type { Context } from 'hono';
import { enterTenant } from '../access.js';
import { AdminRefused, refusedBy, routeOnlyActions } from '../admin.js';
import { requireFlag } from '../feature-flags.js';
import { changeReasonOf } from '../http.js';
import { t } from '../i18n/index.js';
import type { PlatformModuleFactory } from '../platform-modules.js';
import { connectorCaller } from './acting.js';
import type { DesignConnector } from './oauth.js';
import type { DesignConnectorSettings } from './settings.js';

export const connectAction = 'platform.design-connector.connect';
export const disconnectAction = 'platform.design-connector.disconnect';
const disconnectReason = 'Koblet Claude fra Utforming';

const personKinds = new Set<Principal['kind']>(['employee', 'operator']);

const refused = (c: Context, status: 403 | 404, code: string, title: string) =>
  c.json({ type: `urn:genai:problem:${code}`, title, status }, status, {
    'content-type': 'application/problem+json',
  });

/** The person as the grant keeps them: one organisation, and never as an operator. */
export const grantPrincipal = (principal: Principal, tenant: string): Principal => {
  const kept = principal.authorizedFor?.filter((a) => a.org === tenant);
  const name = principal.orgNames?.[tenant];
  return {
    kind: principal.kind === 'operator' ? 'employee' : principal.kind,
    subject: principal.subject,
    issuer: principal.issuer,
    ...(principal.name ? { name: principal.name } : {}),
    ...(principal.email ? { email: principal.email } : {}),
    ...(principal.assurance ? { assurance: principal.assurance } : {}),
    ...(principal.client ? { client: principal.client } : {}),
    ...(principal.scopes ? { scopes: principal.scopes } : {}),
    ...(principal.roles ? { roles: principal.roles } : {}),
    ...(principal.tenant === tenant ? { tenant } : {}),
    ...(kept && kept.length > 0 ? { authorizedFor: kept } : {}),
    ...(name ? { orgNames: { [tenant]: name } } : {}),
  };
};

const isPerson = (principal: Principal) =>
  personKinds.has(principal.kind) &&
  !isApiKeyPrincipal(principal) &&
  !principal.confinedTo &&
  !connectorCaller();

const redirectHost = (uri: string) => {
  const url = new URL(uri);
  return url.protocol === 'https:' ? url.hostname : 'loopback';
};

/** Block Studio's side of the connector: a person approves a connection, and ends their own. */
export const designConnectorModule =
  (connector: DesignConnector, settings: DesignConnectorSettings): PlatformModuleFactory =>
  () => ({
    id: 'design-connector',
    handlers: routeOnlyActions([connectAction, disconnectAction]),
    mount: (app, mounted) => {
      const studio = requireFlag(mounted, 'blockStudio');

      const person = async (c: Context) => {
        const principal = await mounted.authenticate(c.req.raw);
        if (!principal || !isPerson(principal))
          return {
            response: refused(c, 404, 'design-connector-person-only', t('problems.status404')),
          };
        const tenant = c.req.param('tenant') ?? '';
        const entered = enterTenant(
          c,
          mounted.access,
          grantPrincipal(principal, tenant),
          tenant,
          'manage-services',
        );
        return 'response' in entered ? entered : { principal: entered.principal, tenant };
      };

      app.get('/tenants/:tenant/design-connector', studio, async (c) => {
        const found = await person(c);
        if ('response' in found) return found.response;
        return c.json({ url: settings.resource });
      });

      app.get('/tenants/:tenant/design-connector/requests/:request', studio, async (c) => {
        const found = await person(c);
        if ('response' in found) return found.response;
        const pending = await connector.grants.request(c.req.param('request') ?? '');
        if (!pending)
          return refused(c, 404, 'design-connector-request-gone', t('designConnector.requestGone'));
        return c.json({
          client: pending.clientName,
          redirect: redirectHost(pending.redirectUri),
          scope: pending.scope,
          startedAt: new Date(pending.startedAt).toISOString(),
        });
      });

      app.post('/tenants/:tenant/design-connector/requests/:request', studio, async (c) => {
        const found = await person(c);
        if ('response' in found) return found.response;
        const body = (await c.req.json().catch(() => undefined)) as
          { decision?: unknown } | undefined;
        if (body?.decision !== 'allow' && body?.decision !== 'deny')
          return c.json(
            {
              type: 'urn:genai:problem:invalid-request',
              title: t('problems.invalidRequest'),
              status: 400,
              errors: [{ path: 'decision', message: t('designConnector.decisionInvalid') }],
            },
            400,
            { 'content-type': 'application/problem+json' },
          );
        const id = c.req.param('request') ?? '';
        const pending = await connector.grants.request(id);
        if (!pending || pending.approved)
          return refused(c, 404, 'design-connector-request-gone', t('designConnector.requestGone'));
        if (body.decision === 'deny') {
          await connector.grants.takeRequest(id);
          const target = new URL(pending.redirectUri);
          target.searchParams.set('error', 'access_denied');
          if (pending.state !== undefined) target.searchParams.set('state', pending.state);
          target.searchParams.set('iss', settings.issuer);
          return c.json({ redirect: target.toString() });
        }
        try {
          const done = await mounted.admin.within(
            found.principal,
            connectAction,
            { tenant: found.tenant, client: pending.clientName, reason: changeReasonOf(c) ?? '' },
            async () => ({ value: true, target: `design-connector:${found.tenant}` }),
          );
          const approved = await connector.grants.approve(id, {
            tenant: found.tenant,
            principal: found.principal,
            clientId: pending.clientId,
          });
          if (!approved)
            return refused(
              c,
              404,
              'design-connector-request-gone',
              t('designConnector.requestGone'),
            );
          c.header('genai-task', done.task);
          return c.json({ redirect: `${settings.issuer}/finish/${encodeURIComponent(id)}` });
        } catch (error) {
          if (error instanceof AdminRefused) return refusedBy(c, error);
          throw error;
        }
      });

      app.get('/tenants/:tenant/design-connector/grant-check', studio, async (c) => {
        const principal = connectorCaller(c.req.raw)?.principal;
        if (!principal)
          return refused(c, 404, 'design-connector-person-only', t('problems.status404'));
        const entered = enterTenant(
          c,
          mounted.access,
          principal,
          c.req.param('tenant') ?? '',
          'manage-services',
        );
        return 'response' in entered ? entered.response : c.body(null, 204);
      });

      app.delete('/tenants/:tenant/design-connector/grants', studio, async (c) => {
        const principal = await mounted.authenticate(c.req.raw);
        if (!principal || !isPerson(principal))
          return refused(c, 404, 'design-connector-person-only', t('problems.status404'));
        const tenant = c.req.param('tenant') ?? '';
        const entered = enterTenant(c, mounted.access, principal, tenant);
        if ('response' in entered) return entered.response;
        try {
          const done = await mounted.admin.within(
            entered.principal,
            disconnectAction,
            { tenant, reason: changeReasonOf(c) ?? disconnectReason },
            async () => ({
              value: await connector.grants.endFor(principal),
              target: `design-connector:${tenant}`,
            }),
          );
          c.header('genai-task', done.task);
          return c.json({ ended: done.value });
        } catch (error) {
          if (error instanceof AdminRefused) return refusedBy(c, error);
          throw error;
        }
      });
    },
  });
