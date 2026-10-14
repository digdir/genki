import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { z } from 'zod';
import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import {
  createLocalJWKSet,
  decodeJwt,
  jwtVerify,
  SignJWT,
  type JSONWebKeySet,
  type JWTPayload,
} from 'jose';
import type { Locale } from '@genai/i18n';
import { loginLocale, loginText } from './mock-ansattporten-text.js';
import { resourceId, toOrgNo, type AltinnResourceDetail, type AuthorizedParty } from './claims.js';
import type { SigningKey } from './keys.js';
import {
  identityTestData,
  rightsFor,
  type IdentityTestData,
  type IdentityTestDataInput,
  oidcClient,
  type OidcClient,
  type Party,
  type Person,
} from './testdata.js';

export interface MockAnsattportenOptions {
  issuer: string;
  key: SigningKey;
  testData: IdentityTestDataInput;
  browserBaseUrl?: string;
  subjectSalt?: string;
  tokenLifetimeSeconds?: number;
  now?: () => number;
}

export const ALTINN_RESOURCE_DETAIL = 'ansattporten:altinn:resource';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const SCOPES = ['openid', 'profile'];
const SUB_UNITS = ['BEDR', 'AAFY'];

type Acr = 'substantial' | 'high';

export interface RequestedDetail {
  type: typeof ALTINN_RESOURCE_DETAIL;
  resource: string;
  actions?: string[];
  organizationform?: 'enterprise' | 'business';
  allow_multiple_organizations?: boolean;
  representation_is_required?: boolean;
}

interface PendingLogin {
  client: OidcClient;
  redirectUri: string;
  query: string;
  state?: string;
  nonce?: string;
  codeChallenge: string;
  acr: Acr;
  scope: string[];
  audience: string;
  details: RequestedDetail[];
  locale?: Locale;
}

interface Session {
  login: Omit<PendingLogin, 'redirectUri' | 'codeChallenge' | 'query' | 'nonce'> &
    Partial<Pick<PendingLogin, 'redirectUri' | 'codeChallenge'>>;
  nonce?: string;
  pid: string;
  orgs?: string[];
  sid: string;
  authTime: number;
}

const actionList = (raw: unknown): string[] | undefined | 'invalid' => {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string')
    return raw
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
  if (Array.isArray(raw) && raw.every((a) => typeof a === 'string')) return raw;
  return 'invalid';
};

const parseDetails = (raw: string | undefined): RequestedDetail[] | 'invalid' => {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'invalid';
  }
  if (!Array.isArray(parsed)) return 'invalid';
  const details: RequestedDetail[] = [];
  for (const d of parsed as Record<string, unknown>[]) {
    if (typeof d !== 'object' || !d) return 'invalid';
    if (d.type !== ALTINN_RESOURCE_DETAIL || typeof d.resource !== 'string') return 'invalid';
    const actions = actionList(d.actions);
    if (actions === 'invalid') return 'invalid';
    if (
      d.organizationform !== undefined &&
      !['enterprise', 'business'].includes(String(d.organizationform))
    )
      return 'invalid';
    details.push({
      type: ALTINN_RESOURCE_DETAIL,
      resource: d.resource,
      ...(actions ? { actions } : {}),
      ...(d.organizationform
        ? { organizationform: d.organizationform as 'enterprise' | 'business' }
        : {}),
      allow_multiple_organizations: d.allow_multiple_organizations === true,
      representation_is_required: d.representation_is_required === true,
    });
  }
  return details;
};

const fitsForm = (party: Party, form: RequestedDetail['organizationform']) =>
  form === undefined || (form === 'business') === SUB_UNITS.includes(party.unitType);

export const authorizedParties = (
  data: IdentityTestData,
  person: Person,
  detail: Pick<RequestedDetail, 'resource' | 'actions' | 'organizationform'>,
  orgs?: string[],
): AuthorizedParty[] =>
  person.parties.flatMap((p) => {
    if (orgs && !orgs.includes(p.orgno)) return [];
    if (!fitsForm(p, detail.organizationform)) return [];
    const rights = rightsFor(data, p, detail.resource);
    const actions = detail.actions ? rights.filter((a) => detail.actions?.includes(a)) : rights;
    return actions.length
      ? [
          {
            orgno: toOrgNo(p.orgno),
            resource: resourceId(detail.resource),
            name: p.name,
            unit_type: p.unitType,
          },
        ]
      : [];
  });

export const ansattportenClaims = (
  data: IdentityTestData,
  person: Person,
  details: RequestedDetail[],
  orgs?: string[],
): AltinnResourceDetail[] =>
  details.map((d) => ({
    type: ALTINN_RESOURCE_DETAIL,
    resource: d.resource,
    resource_name: data.resourceNames[d.resource] ?? resourceId(d.resource),
    authorized_parties: authorizedParties(data, person, d, orgs),
  }));

const splitName = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return { given_name: parts.slice(0, -1).join(' ') || name, family_name: parts.at(-1) ?? name };
};

const sameSecret = (a: string, b: string) => {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
};

const STYLE = `
  :root { color-scheme: light; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { margin: 0; background: #f4f5f6; color: #1e2b3c; }
  header { background: #1e2b3c; color: #fff; padding: 12px 16px; font-weight: 600; }
  main { max-width: 560px; margin: 32px auto; padding: 0 16px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  p.lead { margin: 0 0 24px; color: #4b5563; }
  .badge { display: inline-block; background: #fff3cd; color: #6b4e00; border-radius: 4px; padding: 2px 8px; font-size: .85rem; margin-bottom: 16px; }
  ul.choices { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  button.choice, label.choice { display: block; width: 100%; text-align: left; background: #fff; border: 1px solid #c9d1db; border-radius: 6px; padding: 12px 16px; font: inherit; color: inherit; cursor: pointer; box-sizing: border-box; }
  button.choice:hover, label.choice:hover { border-color: #0062ba; }
  .choice strong { display: block; }
  .choice span { display: block; color: #4b5563; font-size: .9rem; }
  label.choice { display: flex; gap: 12px; align-items: flex-start; }
  fieldset { border: 0; margin: 0 0 16px; padding: 0; display: grid; gap: 8px; }
  button.primary { background: #0062ba; color: #fff; border: 0; border-radius: 6px; padding: 10px 20px; font: inherit; cursor: pointer; }
  a { color: #0062ba; }
`;

const page = (
  locale: Locale,
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
) =>
  html`<!doctype html>
    <html lang="${locale}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          ${STYLE}
        </style>
      </head>
      <body>
        <header>${loginText(locale)('login.header')}</header>
        <main>
          <span class="badge">${loginText(locale)('login.badge')}</span>
          ${body}
        </main>
      </body>
    </html>`;

export const createMockAnsattporten = (options: MockAnsattportenOptions) => {
  const data = identityTestData.parse(options.testData);
  const salt = options.subjectSalt ?? `mock-ansattporten:${options.issuer}`;
  const now = options.now ?? (() => Date.now());
  const lifetime = options.tokenLifetimeSeconds ?? 3600;
  const browser = options.browserBaseUrl ?? options.issuer;
  const logins = new Map<string, PendingLogin>();
  const codes = new Map<string, Session & { expiresAt: number }>();
  const refreshTokens = new Map<string, Session & { clientId: string; expiresAt: number }>();
  const usedAssertions = new Set<string>();
  const ownKeys = createLocalJWKSet({ keys: [options.key.publicJwk] });
  const app = new Hono();

  const seconds = () => Math.floor(now() / 1000);
  const subjectFor = (pid: string, clientId: string) =>
    createHmac('sha256', salt).update(`${clientId}:${pid}`).digest('base64url');
  const personBy = (pid: string) => data.persons.find((p) => p.pid === pid);

  const sign = (claims: Record<string, unknown>, audience: string) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: options.key.kid, typ: 'JWT' })
      .setIssuer(options.issuer)
      .setAudience(audience)
      .setIssuedAt(seconds())
      .setExpirationTime(seconds() + lifetime)
      .setJti(randomUUID())
      .sign(options.key.privateKey);

  const tokensFor = async (session: Session) => {
    const { login } = session;
    const person = personBy(session.pid);
    if (!person) throw new Error(`unknown test person ${session.pid}`);
    const details = ansattportenClaims(data, person, login.details, session.orgs);
    const common = {
      sub: subjectFor(person.pid, login.client.clientId),
      pid: person.pid,
      acr: login.acr,
      amr: ['TestID'],
      auth_time: session.authTime,
      ...(details.length ? { authorization_details: details } : {}),
    };
    const idToken = await sign(
      {
        ...common,
        sid: session.sid,
        locale: login.locale ?? 'nb',
        ...(login.scope.includes('profile')
          ? { name: person.name, ...splitName(person.name) }
          : {}),
        ...(session.nonce ? { nonce: session.nonce } : {}),
      },
      login.client.clientId,
    );
    const accessToken = await sign(
      {
        ...common,
        client_id: login.client.clientId,
        client_amr: login.client.tokenEndpointAuthMethod,
        scope: login.scope.join(' '),
      },
      login.audience,
    );
    const refreshToken = randomBytes(32).toString('base64url');
    refreshTokens.set(refreshToken, {
      login,
      pid: session.pid,
      sid: session.sid,
      authTime: session.authTime,
      ...(session.orgs ? { orgs: session.orgs } : {}),
      clientId: login.client.clientId,
      expiresAt: now() + 8 * 3600_000,
    });
    return {
      access_token: accessToken,
      id_token: idToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: lifetime,
      scope: login.scope.join(' '),
    };
  };

  const candidates = (person: Person, login: PendingLogin) =>
    person.parties.filter((p) =>
      login.details.some((d) => authorizedParties(data, person, d, [p.orgno]).length > 0),
    );

  const finish = (loginId: string, login: PendingLogin, pid: string, orgs?: string[]) => {
    logins.delete(loginId);
    const code = randomBytes(24).toString('base64url');
    codes.set(code, {
      login,
      pid,
      sid: randomUUID(),
      authTime: seconds(),
      expiresAt: now() + 60_000,
      ...(login.nonce ? { nonce: login.nonce } : {}),
      ...(orgs ? { orgs } : {}),
    });
    const target = new URL(login.redirectUri);
    target.searchParams.set('code', code);
    if (login.state) target.searchParams.set('state', login.state);
    target.searchParams.set('iss', options.issuer);
    return target.toString();
  };

  const refuse = (login: PendingLogin, error: string, description: string) => {
    const target = new URL(login.redirectUri);
    target.searchParams.set('error', error);
    target.searchParams.set('error_description', description);
    if (login.state) target.searchParams.set('state', login.state);
    target.searchParams.set('iss', options.issuer);
    return target.toString();
  };

  const personPage = (loginId: string, locale: Locale) => {
    const t = loginText(locale);
    return page(
      locale,
      t('login.personTitle'),
      html`<h1>${t('login.personHeading')}</h1>
        <p class="lead">${t('login.personLead')}</p>
        <form method="post" action="authorize">
          <input type="hidden" name="login" value="${loginId}" />
          <ul class="choices">
            ${data.persons.map(
              (p) =>
                html`<li>
                  <button class="choice" type="submit" name="pid" value="${p.pid}">
                    <strong>${p.name}</strong>
                    <span>${t('login.nationalId', { pid: p.pid })}</span>
                    ${p.description ? html`<span>${p.description}</span>` : ''}
                  </button>
                </li>`,
            )}
          </ul>
        </form>`,
    );
  };

  const organisationPage = (
    loginId: string,
    login: PendingLogin,
    person: Person,
    parties: Party[],
  ) => {
    const multiple = login.details.some((d) => d.allow_multiple_organizations);
    const required = login.details.some((d) => d.representation_is_required);
    const kind = multiple ? 'checkbox' : 'radio';
    const locale = login.locale ?? 'nb';
    const t = loginText(locale);
    return page(
      locale,
      t('login.organisationTitle'),
      html`<h1>${t('login.organisationHeading')}</h1>
        <p class="lead">${t('login.hello', { name: person.name })}</p>
        <form method="post" action="authorize">
          <input type="hidden" name="login" value="${loginId}" />
          <input type="hidden" name="pid" value="${person.pid}" />
          <input type="hidden" name="step" value="organisation" />
          <fieldset>
            ${parties.map(
              (p, i) =>
                html`<label class="choice">
                  <input type="${kind}" name="org" value="${p.orgno}" ${i === 0 ? 'checked' : ''} />
                  <div>
                    <strong>${p.name}</strong>
                    <span>${t('login.orgNumber', { orgno: p.orgno, unitType: p.unitType })}</span>
                  </div>
                </label>`,
            )}
            ${
              required || multiple
                ? ''
                : html`<label class="choice">
                    <input type="radio" name="org" value="" />
                    <div>
                      <strong>${t('login.myself')}</strong><span>${t('login.myselfHint')}</span>
                    </div>
                  </label>`
            }
          </fieldset>
          <button class="primary" type="submit">${t('login.next')}</button>
        </form>
        <p><a href="authorize?${login.query}">${t('login.otherPerson')}</a></p>`,
    );
  };

  app.get('/.well-known/openid-configuration', (c) =>
    c.json({
      issuer: options.issuer,
      authorization_endpoint: `${browser}/authorize`,
      token_endpoint: `${options.issuer}/token`,
      userinfo_endpoint: `${options.issuer}/userinfo`,
      end_session_endpoint: `${browser}/logout`,
      jwks_uri: `${options.issuer}/jwks.json`,
      scopes_supported: SCOPES,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      subject_types_supported: ['pairwise'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post',
        'none',
        'private_key_jwt',
      ],
      token_endpoint_auth_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      acr_values_supported: ['substantial', 'high'],
      authorization_details_types_supported: [ALTINN_RESOURCE_DETAIL],
      authorization_response_iss_parameter_supported: true,
      ui_locales_supported: ['nb', 'en'],
      prompt_values_supported: ['login'],
      request_parameter_supported: false,
      claims_parameter_supported: false,
    }),
  );

  const jwks = () => ({ keys: [options.key.publicJwk] });
  app.get('/jwks.json', (c) => c.json(jwks()));
  app.get('/jwks', (c) => c.json(jwks()));

  app.get('/authorize', (c) => {
    const q = c.req.query();
    const client = data.clients.find((x) => x.clientId === q.client_id);
    if (!client || !q.redirect_uri || !client.redirectUris.includes(q.redirect_uri))
      return c.json(
        { error: 'invalid_request', error_description: 'unknown client or redirect_uri' },
        400,
      );
    if (q.response_type !== 'code' || !q.code_challenge || q.code_challenge_method !== 'S256')
      return c.json(
        { error: 'invalid_request', error_description: 'code flow with PKCE S256 is required' },
        400,
      );
    const details = parseDetails(q.authorization_details);
    if (details === 'invalid') return c.json({ error: 'invalid_authorization_details' }, 400);
    const audience = q.resource ?? client.audience;
    if (![client.audience, ...client.audiences].includes(audience))
      return c.json({ error: 'invalid_target', error_description: 'unknown resource' }, 400);
    const scope = (q.scope ?? 'openid').split(' ').filter((s) => SCOPES.includes(s));
    if (!scope.includes('openid')) return c.json({ error: 'invalid_scope' }, 400);
    const id = randomUUID();
    const locale = loginLocale(q.ui_locales, c.req.header('accept-language'));
    logins.set(id, {
      client,
      redirectUri: q.redirect_uri,
      query: new URL(c.req.url).search.slice(1),
      codeChallenge: q.code_challenge,
      acr: (q.acr_values ?? '').split(' ').includes('high') ? 'high' : 'substantial',
      scope,
      audience,
      details,
      ...(q.state ? { state: q.state } : {}),
      ...(q.nonce ? { nonce: q.nonce } : {}),
      locale,
    });
    return c.html(personPage(id, locale));
  });

  app.post('/authorize', async (c) => {
    const form = await c.req.parseBody({ all: true });
    const one = (name: string) => (typeof form[name] === 'string' ? form[name] : undefined);
    const loginId = one('login') ?? '';
    const login = logins.get(loginId);
    const person = personBy(one('pid') ?? '');
    if (!login || !person)
      return c.json(
        { error: 'invalid_request', error_description: 'unknown login or person' },
        400,
      );
    if (login.details.length === 0) return c.redirect(finish(loginId, login, person.pid), 302);
    const parties = candidates(person, login);
    const required = login.details.some((d) => d.representation_is_required);
    if (one('step') !== 'organisation') {
      if (parties.length > 0) return c.html(organisationPage(loginId, login, person, parties));
      logins.delete(loginId);
      return required
        ? c.redirect(
            refuse(login, 'access_denied', 'the person cannot represent any organisation'),
            302,
          )
        : c.redirect(finish(loginId, login, person.pid, []), 302);
    }
    const chosen = [form.org ?? []]
      .flat()
      .filter((o): o is string => typeof o === 'string' && o !== '');
    const multiple = login.details.some((d) => d.allow_multiple_organizations);
    const valid =
      chosen.every((o) => parties.some((p) => p.orgno === o)) &&
      (multiple || chosen.length <= 1) &&
      (!required || chosen.length > 0);
    if (!valid) return c.html(organisationPage(loginId, login, person, parties), 400);
    return c.redirect(finish(loginId, login, person.pid, chosen), 302);
  });

  const authenticateClient = async (
    header: string | undefined,
    field: (name: string) => string | undefined,
  ): Promise<OidcClient | undefined> => {
    const basic = /^Basic (.+)$/.exec(header ?? '')?.[1];
    const [basicId, basicSecret] = basic
      ? Buffer.from(basic, 'base64')
          .toString()
          .split(/:(.*)/s)
          .map((p) => decodeURIComponent(p.replaceAll('+', ' ')))
      : [];
    const assertion = field('client_assertion');
    let assertionIssuer: string | undefined;
    if (assertion) {
      if (field('client_assertion_type') !== CLIENT_ASSERTION_TYPE) return undefined;
      try {
        assertionIssuer = decodeJwt(assertion).iss;
      } catch {
        return undefined;
      }
    }
    const claimed = [basicId, field('client_id'), assertionIssuer].filter(
      (x): x is string => x !== undefined,
    );
    const clientId = claimed[0];
    if (!clientId || claimed.some((x) => x !== clientId)) return undefined;
    const client = data.clients.find((x) => x.clientId === clientId);
    if (!client) return undefined;
    const method = basic
      ? 'client_secret_basic'
      : assertion
        ? 'private_key_jwt'
        : field('client_secret') !== undefined
          ? 'client_secret_post'
          : 'none';
    if (method !== client.tokenEndpointAuthMethod) return undefined;
    if (method === 'client_secret_basic')
      return sameSecret(basicSecret ?? '', client.clientSecret ?? '') ? client : undefined;
    if (method === 'client_secret_post')
      return sameSecret(field('client_secret') ?? '', client.clientSecret ?? '')
        ? client
        : undefined;
    if (method === 'private_key_jwt') {
      try {
        const { payload } = await jwtVerify(
          assertion ?? '',
          createLocalJWKSet(client.jwks as JSONWebKeySet),
          {
            issuer: client.clientId,
            subject: client.clientId,
            audience: options.issuer,
            algorithms: ['RS256'],
            requiredClaims: ['jti', 'exp', 'iat'],
            maxTokenAge: 120,
            currentDate: new Date(now()),
          },
        );
        if (usedAssertions.has(payload.jti as string)) return undefined;
        usedAssertions.add(payload.jti as string);
      } catch {
        return undefined;
      }
    }
    return client;
  };

  app.post('/token', async (c) => {
    const form = await c.req.parseBody();
    const field = (name: string) => (typeof form[name] === 'string' ? form[name] : undefined);
    const client = await authenticateClient(c.req.header('authorization'), field);
    if (!client) return c.json({ error: 'invalid_client' }, 401);
    const grant = field('grant_type');
    if (grant === 'refresh_token') {
      const token = field('refresh_token') ?? '';
      const session = refreshTokens.get(token);
      refreshTokens.delete(token);
      if (!session || session.expiresAt < now() || session.clientId !== client.clientId)
        return c.json({ error: 'invalid_grant' }, 400);
      return c.json(await tokensFor(session));
    }
    if (grant !== 'authorization_code') return c.json({ error: 'unsupported_grant_type' }, 400);
    const issued = codes.get(field('code') ?? '');
    codes.delete(field('code') ?? '');
    if (!issued || issued.expiresAt < now()) return c.json({ error: 'invalid_grant' }, 400);
    const { login } = issued;
    const challenge = createHash('sha256')
      .update(field('code_verifier') ?? '')
      .digest('base64url');
    if (
      client.clientId !== login.client.clientId ||
      field('redirect_uri') !== login.redirectUri ||
      challenge !== login.codeChallenge
    )
      return c.json({ error: 'invalid_grant' }, 400);
    return c.json(await tokensFor(issued));
  });

  app.get('/userinfo', async (c) => {
    const token = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1];
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token ?? '', ownKeys, {
        issuer: options.issuer,
        currentDate: new Date(now()),
      }));
    } catch {
      return c.json({ error: 'invalid_token' }, 401);
    }
    const person = personBy(String(payload.pid));
    if (!person || typeof payload.client_id !== 'string')
      return c.json({ error: 'invalid_token' }, 401);
    const profile = String(payload.scope ?? '')
      .split(' ')
      .includes('profile');
    return c.json({
      sub: payload.sub,
      pid: person.pid,
      locale: 'nb',
      ...(profile ? { name: person.name, ...splitName(person.name) } : {}),
    });
  });

  app.get('/logout', (c) => {
    const q = c.req.query();
    let clientId = q.client_id;
    if (!clientId && q.id_token_hint) {
      try {
        const aud = decodeJwt(q.id_token_hint).aud;
        clientId = Array.isArray(aud) ? aud[0] : aud;
      } catch {
        clientId = undefined;
      }
    }
    const client = data.clients.find((x) => x.clientId === clientId);
    const target = q.post_logout_redirect_uri;
    if (client && target && client.postLogoutRedirectUris.includes(target)) {
      const url = new URL(target);
      if (q.state) url.searchParams.set('state', q.state);
      return c.redirect(url.toString(), 302);
    }
    const locale = loginLocale(q.ui_locales, c.req.header('accept-language'));
    const t = loginText(locale);
    return c.html(
      page(
        locale,
        t('login.loggedOutTitle'),
        html`<h1>${t('login.loggedOutHeading')}</h1>
          <p class="lead">${t('login.loggedOutLead')}</p>`,
      ),
    );
  });

  const testTokens = (
    pid: string,
    clientId: string,
    resources: string[] = [],
    acr: Acr = 'substantial',
    orgs?: string[],
  ) => {
    const client = data.clients.find((x) => x.clientId === clientId);
    if (!client) throw new Error(`unknown client ${clientId}`);
    return tokensFor({
      pid,
      sid: randomUUID(),
      authTime: seconds(),
      login: {
        client,
        acr,
        scope: ['openid', 'profile'],
        audience: client.audience,
        details: resources.map((resource) => ({ type: ALTINN_RESOURCE_DETAIL, resource })),
      },
      ...(orgs ? { orgs } : {}),
    });
  };

  const clients = {
    register: (input: z.input<typeof oidcClient>) => {
      const client = oidcClient.parse(input);
      const at = data.clients.findIndex((x) => x.clientId === client.clientId);
      if (at < 0) data.clients.push(client);
      else data.clients[at] = client;
    },
    remove: (clientId: string) => {
      const at = data.clients.findIndex((x) => x.clientId === clientId);
      if (at >= 0) data.clients.splice(at, 1);
    },
  };

  return { app, testTokens, testData: data, clients };
};
