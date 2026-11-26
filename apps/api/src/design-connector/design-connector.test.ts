import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BlockDetail, BlockSummary, Principal } from '@genai/contracts';
import { describe, expect, it } from 'vitest';
import { InMemoryBffSessions } from '../bff/sessions.js';
import { platformModules } from '../composition.js';
import { maskinportenClientsModule } from '../maskinporten-clients.js';
import { onboardingModule } from '../onboarding.js';
import { bundleText, codeBlock } from '../block-code.test-utils.js';
import { bootPlatform, digdir, other } from '../testkit.js';
import { actAsConnector, connectorCaller, connectorHeader } from './acting.js';
import { designConnectorModule } from './consent.js';
import { grantMs, hash, type Grant } from './grants.js';
import { createDesignConnector, limits } from './oauth.js';
import { testConnectorSettings } from './design-connector.test-utils.js';
import { designConnectorFrom } from './settings.js';

const resource = 'urn:altinn:resource:digdir-genai-platform';
const person = (subject: string, actions: string[], orgs = [digdir]): Principal => ({
  kind: 'employee',
  issuer: 'test',
  subject,
  tenant: orgs[0] as string,
  authorizedFor: orgs.map((org) => ({ org, resource, actions })),
});

const people: Record<string, Principal> = {
  kari: person('kari', ['use-services', 'manage-services']),
  erik: person('erik', ['use-services']),
  ola: person('ola', ['use-services', 'manage-services'], [other]),
  robotSelf: person('robot', ['use-services', 'manage-services']),
  robot: {
    ...person('robot', ['use-services', 'manage-services']),
    confinedTo: { tenant: digdir, client: 'en-tjeneste' },
  },
  per: { ...person('per', ['use-services', 'manage-services'], [digdir, other]), kind: 'operator' },
};

const settings = testConnectorSettings;

const connectReason = 'Kobler Claude til Utforming';
const claudeCallback = 'https://claude.ai/api/mcp/auth_callback';

const design = (name: string) =>
  readFileSync(
    new URL(`../../../../packages/block-import/src/fixtures/${name}`, import.meta.url),
    'utf8',
  );

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

const boot = async ({
  studio = true,
  start = Date.parse('2026-11-26T10:00:00Z'),
  blockOrigin,
}: { studio?: boolean; start?: number; blockOrigin?: string } = {}) => {
  let at = start;
  const now = () => at;
  const store = new InMemoryBffSessions(now);
  let inner: (request: Request) => Response | Promise<Response> = () =>
    new Response(null, { status: 503 });
  const connector = createDesignConnector({
    settings,
    store,
    partition: digdir,
    inner: (request) => inner(request),
    now,
  });
  const booted = await bootPlatform({
    people,
    ...(blockOrigin ? { blockOrigin } : {}),
    modules: [
      ...platformModules,
      onboardingModule,
      maskinportenClientsModule,
      designConnectorModule(connector, settings),
    ],
  });
  inner = (request) => booted.app.fetch(request);
  for (const orgNumber of [digdir, other])
    await booted.platform.directory.ensure(
      { orgNumber, name: `Virksomhet ${orgNumber}`, status: 'active' },
      'platform:seed',
    );
  for (const who of studio ? ['kari', 'erik', 'ola', 'per', 'robotSelf'] : []) {
    const tenant = who === 'ola' || who === 'per' ? other : digdir;
    const switched = await booted.send(`/tenants/${tenant}/me/flags/blockStudio`, who, {
      method: 'PUT',
      body: { on: true },
      reason: 'Prøver Utforming i laben',
    });
    expect(switched.status).toBe(200);
  }

  const outside = (path: string, init: RequestInit = {}) =>
    connector.fetch(new Request(`${settings.origin}${path}`, init));

  const register = async (body: Record<string, unknown> = {}) =>
    outside('/oauth/design/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: [claudeCallback],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        ...body,
      }),
    });

  const authorize = (params: Record<string, string>) =>
    outside(`/oauth/design/authorize?${new URLSearchParams(params)}`);

  const token = (form: Record<string, string>, headers: Record<string, string> = {}) =>
    outside('/oauth/design/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(form).toString(),
    });

  const requestOf = (response: Response) => {
    const location = response.headers.get('location') ?? '';
    expect(location.startsWith(`${settings.portal}/#/design/connect/`)).toBe(true);
    return location.slice(`${settings.portal}/#/design/connect/`.length);
  };

  const cookieOf = (response: Response) =>
    (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  /** Has `who` approve the request `started` made, then finishes it in the browser that started it. */
  const approve = async (started: Response, who = 'kari', tenant = digdir) => {
    const approved = await booted.send(
      `/tenants/${tenant}/design-connector/requests/${requestOf(started)}`,
      who,
      { body: { decision: 'allow' }, reason: connectReason },
    );
    expect(approved.status).toBe(200);
    const finish = new URL(((await approved.json()) as { redirect: string }).redirect);
    const finished = await outside(finish.pathname + finish.search, {
      headers: { cookie: cookieOf(started) },
    });
    expect(finished.status).toBe(302);
    return new URL(finished.headers.get('location') ?? '').searchParams.get('code') ?? '';
  };

  /** Registers Claude, has `who` approve it for `tenant` and swaps the code for tokens. */
  const connect = async (who = 'kari', tenant = digdir) => {
    const client = (await (await register()).json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const started = await authorize({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: claudeCallback,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'claude-state',
      scope: 'design',
      resource: settings.resource,
    });
    const code = await approve(started, who, tenant);
    const tokens = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: claudeCallback,
      code_verifier: verifier,
      client_id: client.client_id,
    });
    expect(tokens.status).toBe(200);
    const body = (await tokens.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    return { ...body, clientId: client.client_id };
  };

  let rpcId = 0;
  const mcp = (accessToken: string | undefined, method: string, params: unknown = {}) =>
    outside('/mcp/design', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });

  const callTool = async (accessToken: string, name: string, args: unknown) => {
    const response = await mcp(accessToken, 'tools/call', { name, arguments: args });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    return {
      text: body.result.content.map((c) => c.text).join('\n'),
      isError: body.result.isError === true,
    };
  };

  const own = async (who = 'kari', tenant = digdir) =>
    (
      (await (await booted.send(`/tenants/${tenant}/blocks?origin=own`, who)).json()) as {
        data: BlockSummary[];
      }
    ).data;

  return {
    ...booted,
    connector,
    store,
    outside,
    register,
    authorize,
    token,
    requestOf,
    cookieOf,
    approve,
    connect,
    mcp,
    callTool,
    own,
    advance: (ms: number) => {
      at += ms;
    },
  };
};

describe('the design connector for Claude', () => {
  it('lets Claude send a design as a draft of the organisation and links to it in Block Studio', async () => {
    const { connect, mcp, callTool, own, send } = await boot();
    const { access_token } = await connect();

    const initialized = await mcp(access_token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'claude-ai', version: '1' },
    });
    const listed = (await (await mcp(access_token, 'tools/list')).json()) as {
      result: { tools: { name: string }[] };
    };
    const sent = await callTool(access_token, 'import_design', {
      name: 'Velkommen',
      html: design('plain.html'),
      description: 'Velkomstkort for forsiden',
    });

    expect(initialized.status).toBe(200);
    expect(listed.result.tools.map((t) => t.name)).toEqual([
      'list_design_elements',
      'get_design_element',
      'import_design',
    ]);
    expect(sent.isError).toBe(false);
    expect(sent.text).toContain(`${settings.portal}/#/design/${digdir}/velkommen`);
    const [saved] = await own();
    expect(saved).toMatchObject({
      id: 'velkommen',
      sharing: 'organisation',
      usedBy: 0,
      latest: { version: 1, fromClaude: true },
    });
    const detail = (await (
      await send(`/tenants/${digdir}/blocks/${digdir}/velkommen`, 'kari')
    ).json()) as BlockDetail;
    expect(detail.edition.publishedBy).toBe('employee:test:kari');
    expect(detail.edition.reason).toBe('Importert fra Claude: Velkommen');
  });

  it('saves a new edition of an existing design element only when asked to', async () => {
    const { connect, callTool, own } = await boot();
    const { access_token } = await connect();
    await callTool(access_token, 'import_design', {
      name: 'Velkommen',
      html: design('plain.html'),
    });

    const again = await callTool(access_token, 'import_design', {
      name: 'Velkommen',
      html: design('plain.html'),
    });
    const asked = await callTool(access_token, 'import_design', {
      name: 'Velkommen',
      html: design('plain.html'),
      element: 'velkommen',
    });

    expect(again.isError).toBe(true);
    expect(again.text).toContain('element: "velkommen"');
    expect(asked.isError).toBe(false);
    expect((await own())[0]?.latest.version).toBe(2);
  });

  it('refuses a design that needs code and saves nothing', async () => {
    const { connect, callTool, own } = await boot();
    const { access_token } = await connect();

    const sent = await callTool(access_token, 'import_design', {
      name: 'Skript',
      html: '<div><p>Hei</p><script>fetch("https://evil.example")</script></div>',
    });

    expect(sent.isError).toBe(true);
    expect(sent.text).toContain('scripts');
    expect(await own()).toEqual([]);
  });

  it('refuses a design over 512 KiB before importing it', async () => {
    const { connect, callTool, own } = await boot();
    const { access_token } = await connect();

    const sent = await callTool(access_token, 'import_design', {
      name: 'Stor',
      html: `<p>${'a'.repeat(512 * 1024)}</p>`,
    });

    expect(sent.isError).toBe(true);
    expect(sent.text).toContain('512 KiB');
    expect(await own()).toEqual([]);
  });

  it('refuses a new edition of a design element with code from Claude', async () => {
    const { connect, callTool, platform } = await boot({
      blockOrigin: 'https://blocks.genki.test',
    });
    const published = await platform.definitions.publish(
      codeBlock(digdir),
      'platform:seed',
      'Figur med kode',
      { 'block/bundle.js': bundleText },
    );
    expect(published.ok).toBe(true);
    const { access_token } = await connect();

    const sent = await callTool(access_token, 'import_design', {
      name: 'Figur',
      html: design('plain.html'),
      element: 'figur',
    });

    expect(sent.isError).toBe(true);
    expect(sent.text).toContain('without code');
  });

  it('keeps a grant to the organisation it was approved in', async () => {
    const { connect, connector } = await boot();
    const { access_token } = await connect('per', other);

    const kept = (await connector.grants.grantOf(access_token))?.grant;

    expect(kept?.tenant).toBe(other);
    expect(kept?.principal.authorizedFor?.map((a) => a.org)).toEqual([other]);
  });

  it('never keeps operator rights in a grant', async () => {
    const { connect, connector } = await boot();
    const { access_token } = await connect('per', other);

    const kept = (await connector.grants.grantOf(access_token))?.grant;

    expect(kept?.principal.kind).toBe('employee');
    expect(kept?.principal.actor).toBeUndefined();
  });

  it("imports into the grant's organisation only", async () => {
    const { connect, callTool, own } = await boot();
    const { access_token } = await connect('ola', other);

    await callTool(access_token, 'import_design', { name: 'Kort', html: design('plain.html') });

    expect((await own('ola', other)).map((b) => b.id)).toEqual(['kort']);
    expect(await own('kari', digdir)).toEqual([]);
  });

  it('refuses consent for an organisation the person is not in', async () => {
    const { register, authorize, requestOf, send } = await boot();
    const client = (await (await register()).json()) as { client_id: string };
    const request = requestOf(
      await authorize({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: claudeCallback,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      }),
    );

    const approved = await send(`/tenants/${digdir}/design-connector/requests/${request}`, 'ola', {
      body: { decision: 'allow' },
      reason: connectReason,
    });

    expect(approved.status).toBe(404);
  });

  it('refuses consent from anyone but a person signed in to genki itself', async () => {
    const { register, authorize, requestOf, send, connector } = await boot();
    const client = (await (await register()).json()) as { client_id: string };
    const request = requestOf(
      await authorize({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: claudeCallback,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      }),
    );

    const approved = await send(
      `/tenants/${digdir}/design-connector/requests/${request}`,
      'robot',
      {
        body: { decision: 'allow' },
        reason: connectReason,
      },
    );

    expect(approved.status).toBe(404);
    expect(await connector.grants.request(request)).toBeDefined();
  });

  it('refuses consent from a person without manage-services', async () => {
    const { register, authorize, requestOf, send } = await boot();
    const client = (await (await register()).json()) as { client_id: string };
    const request = requestOf(
      await authorize({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: claudeCallback,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      }),
    );

    const approved = await send(`/tenants/${digdir}/design-connector/requests/${request}`, 'erik', {
      body: { decision: 'allow' },
      reason: connectReason,
    });

    expect(approved.status).toBe(403);
  });

  it('answers 404 on the consent routes while blockStudio is off, and leaves the request pending', async () => {
    const { send, register, authorize, requestOf, connector } = await boot({ studio: false });
    const client = (await (await register()).json()) as { client_id: string };
    const request = requestOf(
      await authorize({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: claudeCallback,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      }),
    );

    const info = await send(`/tenants/${digdir}/design-connector`, 'kari');
    const approved = await send(`/tenants/${digdir}/design-connector/requests/${request}`, 'kari', {
      body: { decision: 'allow' },
      reason: connectReason,
    });

    expect(info.status).toBe(404);
    expect(approved.status).toBe(404);
    expect(await connector.grants.request(request)).toBeDefined();
  });

  it('stops the tools once blockStudio is turned off for the person', async () => {
    const { connect, callTool, send, own } = await boot();
    const { access_token } = await connect();
    await send(`/tenants/${digdir}/me/flags/blockStudio`, 'kari', {
      method: 'PUT',
      body: { on: false },
      reason: 'Slår av Utforming igjen',
    });

    const sent = await callTool(access_token, 'import_design', {
      name: 'Velkommen',
      html: design('plain.html'),
    });

    expect(sent.isError).toBe(true);
    expect(sent.text).toContain('not switched on');
    expect(await own()).toEqual([]);
  });

  it('issues no code when the approval is finished in a browser that did not start the connection', async () => {
    const { register, authorize, requestOf, cookieOf, send, outside, connector } = await boot();
    const client = (await (await register()).json()) as { client_id: string };
    const start = () =>
      authorize({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: claudeCallback,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      });
    const attackers = await start();
    const victims = await start();
    const request = requestOf(attackers);
    const approved = await send(`/tenants/${digdir}/design-connector/requests/${request}`, 'kari', {
      body: { decision: 'allow' },
      reason: connectReason,
    });
    const redirect = new URL(((await approved.json()) as { redirect: string }).redirect);
    const finish = redirect.pathname + redirect.search;

    const withoutCookie = await outside(finish);
    const again = await outside(finish, { headers: { cookie: cookieOf(attackers) } });
    const wrongCookie = await outside(finish, {
      headers: { cookie: cookieOf(victims).replace(requestOf(victims), request) },
    });

    expect(withoutCookie.status).toBe(403);
    expect(withoutCookie.headers.get('location')).toBeNull();
    expect(await withoutCookie.text()).toContain('samme nettleser');
    expect(again.status).toBe(404);
    expect(wrongCookie.status).toBe(404);
    expect(await connector.grants.request(request)).toBeUndefined();
  });

  it('gives no code when the browser that started the connection finishes after someone else approved it', async () => {
    const { register, authorize, requestOf, cookieOf, send, outside, connector } = await boot();
    const client = (await (await register()).json()) as { client_id: string };
    const attackers = await authorize({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: claudeCallback,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    });
    const request = requestOf(attackers);
    const approved = await send(`/tenants/${digdir}/design-connector/requests/${request}`, 'kari', {
      body: { decision: 'allow' },
      reason: connectReason,
    });
    const handedToVictim = new URL(((await approved.json()) as { redirect: string }).redirect);

    const polled = await outside(handedToVictim.pathname, {
      headers: { cookie: cookieOf(attackers) },
    });
    const withSecretAfter = await outside(handedToVictim.pathname + handedToVictim.search, {
      headers: { cookie: cookieOf(attackers) },
    });

    expect(polled.status).toBe(403);
    expect(polled.headers.get('location')).toBeNull();
    expect(withSecretAfter.status).toBe(404);
    expect(withSecretAfter.headers.get('location')).toBeNull();
    expect(await connector.grants.request(request)).toBeUndefined();
    expect(await connector.grants.approval(request)).toBeUndefined();
  });

  it('ends a connection that is finished before it is approved', async () => {
    const { register, authorize, requestOf, cookieOf, send, outside } = await boot();
    const client = (await (await register()).json()) as { client_id: string };
    const started = await authorize({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: claudeCallback,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    });
    const request = requestOf(started);

    const early = await outside(`/oauth/design/finish/${request}`, {
      headers: { cookie: cookieOf(started) },
    });
    const approved = await send(`/tenants/${digdir}/design-connector/requests/${request}`, 'kari', {
      body: { decision: 'allow' },
      reason: connectReason,
    });

    expect(early.status).toBe(404);
    expect(approved.status).toBe(404);
  });

  it('approve, disconnect before finish: no code and no grant', async () => {
    const { register, authorize, requestOf, cookieOf, send, outside, connector } = await boot();
    const client = (await (await register()).json()) as { client_id: string };
    const started = await authorize({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: claudeCallback,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    });
    const request = requestOf(started);
    const approved = await send(`/tenants/${digdir}/design-connector/requests/${request}`, 'kari', {
      body: { decision: 'allow' },
      reason: connectReason,
    });
    const finish = new URL(((await approved.json()) as { redirect: string }).redirect);

    await send(`/tenants/${digdir}/design-connector/grants`, 'kari', { method: 'DELETE' });
    const finished = await outside(finish.pathname + finish.search, {
      headers: { cookie: cookieOf(started) },
    });

    expect(finished.status).toBe(404);
    expect(finished.headers.get('location')).toBeNull();
    expect(await connector.grants.approval(request)).toBeUndefined();
  });

  it('sets the browser cookie HttpOnly, Secure and SameSite=Lax, and never puts it in a URL', async () => {
    const { register, authorize } = await boot();
    const client = (await (await register()).json()) as { client_id: string };

    const started = await authorize({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: claudeCallback,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    });
    const cookie = started.headers.get('set-cookie') ?? '';
    const value = cookie.split(';')[0]?.split('=')[1] ?? '';

    expect(cookie).toMatch(/^__Host-genki-design-/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=300/);
    expect(started.headers.get('location')).not.toContain(value);
  });

  it('cannot approve a connection started more than five minutes ago', async () => {
    const { register, authorize, requestOf, send, advance } = await boot();
    const client = (await (await register()).json()) as { client_id: string };
    const request = requestOf(
      await authorize({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: claudeCallback,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      }),
    );

    advance(5 * 60_000 + 1);
    const shown = await send(`/tenants/${digdir}/design-connector/requests/${request}`, 'kari');
    const approved = await send(`/tenants/${digdir}/design-connector/requests/${request}`, 'kari', {
      body: { decision: 'allow' },
      reason: connectReason,
    });

    expect(shown.status).toBe(404);
    expect(approved.status).toBe(404);
  });

  it('shows the person when the connection was started', async () => {
    const { register, authorize, requestOf, send } = await boot();
    const client = (await (await register()).json()) as { client_id: string };
    const request = requestOf(
      await authorize({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: claudeCallback,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      }),
    );

    const shown = await send(`/tenants/${digdir}/design-connector/requests/${request}`, 'kari');

    expect(await shown.json()).toMatchObject({ startedAt: '2026-11-26T10:00:00.000Z' });
  });

  it('takes a pending request once, so a second approval finds nothing', async () => {
    const { register, authorize, requestOf, send } = await boot();
    const client = (await (await register()).json()) as { client_id: string };
    const request = requestOf(
      await authorize({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: claudeCallback,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      }),
    );
    const path = `/tenants/${digdir}/design-connector/requests/${request}`;

    const first = await send(path, 'kari', { body: { decision: 'allow' }, reason: connectReason });
    const second = await send(path, 'kari', { body: { decision: 'allow' }, reason: connectReason });

    expect(first.status).toBe(200);
    expect(second.status).toBe(404);
  });

  it('keeps a request open for a second try when the approval is refused for a missing reason', async () => {
    const { register, authorize, requestOf, send } = await boot();
    const client = (await (await register()).json()) as { client_id: string };
    const request = requestOf(
      await authorize({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: claudeCallback,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      }),
    );
    const path = `/tenants/${digdir}/design-connector/requests/${request}`;

    const refused = await send(path, 'kari', { body: { decision: 'allow' } });
    const retried = await send(path, 'kari', {
      body: { decision: 'allow' },
      reason: connectReason,
    });

    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(retried.status).toBe(200);
  });

  it('sends a refusal back to Claude without a code when the person says no', async () => {
    const { register, authorize, requestOf, send } = await boot();
    const client = (await (await register()).json()) as { client_id: string };
    const request = requestOf(
      await authorize({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: claudeCallback,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
        state: 's1',
      }),
    );

    const denied = await send(`/tenants/${digdir}/design-connector/requests/${request}`, 'kari', {
      body: { decision: 'deny' },
      reason: connectReason,
    });
    const redirect = new URL(((await denied.json()) as { redirect: string }).redirect);

    expect(redirect.origin + redirect.pathname).toBe(claudeCallback);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('state')).toBe('s1');
    expect(redirect.searchParams.has('code')).toBe(false);
  });

  it('audits the connection and every import with the person as the actor', async () => {
    const { connect, callTool, admin } = await boot();
    const { access_token } = await connect();
    await callTool(access_token, 'import_design', {
      name: 'Velkommen',
      html: design('plain.html'),
    });

    const audit = await admin.audit(digdir);

    expect(audit.find((a) => a.action === 'platform.design-connector.connect')).toMatchObject({
      actor: 'employee:test:kari',
      outcome: 'applied',
    });
    expect(
      audit.find(
        (a) =>
          a.action === 'platform.service.publish' && a.reason?.startsWith('Importert fra Claude'),
      ),
    ).toMatchObject({ actor: 'employee:test:kari', outcome: 'applied' });
  });
});

describe('the design connector OAuth server', () => {
  it('describes the MCP endpoint as a protected resource and itself as its authorization server', async () => {
    const { outside } = await boot();

    const resourceDoc = (await (
      await outside('/.well-known/oauth-protected-resource/mcp/design')
    ).json()) as Record<string, unknown>;
    const server = (await (
      await outside('/.well-known/oauth-authorization-server/oauth/design')
    ).json()) as Record<string, unknown>;

    expect(resourceDoc).toMatchObject({
      resource: settings.resource,
      authorization_servers: [settings.issuer],
    });
    expect(server).toMatchObject({
      issuer: settings.issuer,
      code_challenge_methods_supported: ['S256'],
      registration_endpoint: `${settings.issuer}/register`,
    });
  });

  it('answers a call without a token with 401 and where to find the authorization server', async () => {
    const { mcp } = await boot();

    const response = await mcp(undefined, 'tools/list');

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      `resource_metadata="${settings.origin}/.well-known/oauth-protected-resource/mcp/design"`,
    );
  });

  it('never takes an access token from the URL', async () => {
    const { connect, outside } = await boot();
    const { access_token } = await connect();

    const response = await outside(`/mcp/design?access_token=${access_token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(401);
  });

  it.each([
    'https://evil.example/callback',
    'https://claude.ai.evil.example/api/mcp/auth_callback',
    'https://claude.ai/api/mcp/auth_callback/../../steal',
    'http://evil.example/callback',
    'http://localhost:3000/other',
    'javascript:alert(1)',
  ])(
    "refuses to register %s, which is neither Claude's callback nor a loopback one",
    async (uri) => {
      const { register } = await boot();

      const response = await register({ redirect_uris: [uri] });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe('invalid_redirect_uri');
    },
  );

  it('registers a loopback callback for Claude Code and accepts it on another port', async () => {
    const { register, authorize } = await boot();
    const client = (await (
      await register({ redirect_uris: ['http://localhost:5000/callback'] })
    ).json()) as { client_id: string };

    const response = await authorize({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'http://localhost:61234/callback',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain(`${settings.portal}/#/design/connect/`);
  });

  it('never redirects to a URI the client did not register', async () => {
    const { register, authorize } = await boot();
    const client = (await (await register()).json()) as { client_id: string };

    const response = await authorize({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'https://claude.com/api/mcp/auth_callback',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });

  it('refuses a client id genki did not issue', async () => {
    const { authorize } = await boot();

    const response = await authorize({
      response_type: 'code',
      client_id: 'made-up',
      redirect_uri: claudeCallback,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });

  it.each([
    ['without a code challenge', {}],
    [
      'with a plain code challenge',
      { code_challenge: 'a'.repeat(43), code_challenge_method: 'plain' },
    ],
  ])('refuses an authorization request %s', async (_, extra) => {
    const { register, authorize } = await boot();
    const client = (await (await register()).json()) as { client_id: string };

    const response = await authorize({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: claudeCallback,
      state: 's',
      ...extra,
    });

    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe(claudeCallback);
    expect(location.searchParams.get('error')).toBe('invalid_request');
  });

  it('refuses a scope other than design and a resource other than this server', async () => {
    const { register, authorize } = await boot();
    const client = (await (await register()).json()) as { client_id: string };
    const base = {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: claudeCallback,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    };

    const wider = await authorize({ ...base, scope: 'design admin' });
    const elsewhere = await authorize({ ...base, resource: 'https://api.genki.test/v1' });

    expect(new URL(wider.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invalid_scope',
    );
    expect(new URL(elsewhere.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invalid_target',
    );
  });

  it('refuses a code with the wrong verifier, and the code is spent after one try', async () => {
    const { register, authorize, approve, token } = await boot();
    const client = (await (await register()).json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const code = await approve(
      await authorize({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: claudeCallback,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    );
    const form = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: claudeCallback,
      client_id: client.client_id,
    };

    const wrong = await token({ ...form, code_verifier: pkce().verifier });
    const right = await token({ ...form, code_verifier: verifier });

    expect(wrong.status).toBe(400);
    expect(right.status).toBe(400);
  });

  it('refuses a code swapped by another client', async () => {
    const { register, authorize, approve, token } = await boot();
    const client = (await (await register()).json()) as { client_id: string };
    const thief = (await (await register()).json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const code = await approve(
      await authorize({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: claudeCallback,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    );

    const stolen = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: claudeCallback,
      client_id: thief.client_id,
      code_verifier: verifier,
    });

    expect(stolen.status).toBe(400);
  });

  it('needs the client secret of a client registered with one', async () => {
    const { register, token } = await boot();
    const client = (await (
      await register({ token_endpoint_auth_method: 'client_secret_post' })
    ).json()) as { client_id: string; client_secret: string };

    const without = await token({
      grant_type: 'refresh_token',
      refresh_token: 'x',
      client_id: client.client_id,
    });
    const wrong = await token({
      grant_type: 'refresh_token',
      refresh_token: 'x',
      client_id: client.client_id,
      client_secret: 'not-it',
    });

    expect(client.client_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(without.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  it('takes the client secret in the form or as HTTP Basic, and refuses a Basic header it cannot read', async () => {
    const { register, token } = await boot();
    const client = (await (
      await register({ token_endpoint_auth_method: 'client_secret_basic' })
    ).json()) as { client_id: string; client_secret: string };
    const basic = (id: string, secret: string) =>
      `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

    const inForm = await token({
      grant_type: 'refresh_token',
      refresh_token: 'x',
      client_id: client.client_id,
      client_secret: client.client_secret,
    });
    const asBasic = await token(
      { grant_type: 'refresh_token', refresh_token: 'x' },
      { authorization: basic(client.client_id, client.client_secret) },
    );
    const unreadable = await token(
      { grant_type: 'refresh_token', refresh_token: 'x' },
      { authorization: `Basic ${Buffer.from('a%:b').toString('base64')}` },
    );

    expect([inForm.status, asBasic.status]).toEqual([400, 400]);
    expect((await asBasic.json()) as { error: string }).toMatchObject({ error: 'invalid_grant' });
    expect(unreadable.status).toBe(401);
  });

  it('rotates the refresh token, and ends the grant when an old one is used again', async () => {
    const { connect, token, mcp, advance } = await boot();
    const first = await connect();

    const rotated = await token({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: first.clientId,
    });
    const next = (await rotated.json()) as { access_token: string; refresh_token: string };
    advance(31_000);
    const replayed = await token({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: first.clientId,
    });
    const afterReplay = await token({
      grant_type: 'refresh_token',
      refresh_token: next.refresh_token,
      client_id: first.clientId,
    });

    expect(rotated.status).toBe(200);
    expect(next.refresh_token).not.toBe(first.refresh_token);
    expect(replayed.status).toBe(400);
    expect(afterReplay.status).toBe(400);
    expect((await mcp(next.access_token, 'tools/list')).status).toBe(401);
  });

  it('keeps the grant when a client retries a refresh within 30 seconds', async () => {
    const { connect, token, mcp } = await boot();
    const first = await connect();
    const refresh = () =>
      token({
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: first.clientId,
      });

    const rotated = await refresh();
    const next = (await rotated.json()) as { access_token: string };
    const retried = await refresh();

    expect([rotated.status, retried.status]).toEqual([200, 400]);
    expect((await mcp(next.access_token, 'tools/list')).status).toBe(200);
  });

  it('keeps the grant when another client presents its refresh token', async () => {
    const { connect, register, token, mcp } = await boot();
    const mine = await connect();
    const other = (await (await register()).json()) as { client_id: string };

    const stolen = await token({
      grant_type: 'refresh_token',
      refresh_token: mine.refresh_token,
      client_id: other.client_id,
    });

    expect(stolen.status).toBe(400);
    expect((await mcp(mine.access_token, 'tools/list')).status).toBe(200);
  });

  it('gives short-lived access tokens and ends the grant after eight hours', async () => {
    const { connect, token, mcp, advance } = await boot();
    const first = await connect();

    advance(16 * 60_000);
    const expired = await mcp(first.access_token, 'tools/list');
    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: first.clientId,
    });
    const { refresh_token } = (await refreshed.json()) as { refresh_token: string };
    advance(grantMs);
    const late = await token({
      grant_type: 'refresh_token',
      refresh_token,
      client_id: first.clientId,
    });

    expect(first.expires_in).toBe(15 * 60);
    expect(expired.status).toBe(401);
    expect(refreshed.status).toBe(200);
    expect(late.status).toBe(400);
  });

  it('ends every grant and refresh token of the person on «Koble fra»', async () => {
    const { connect, mcp, send, token } = await boot();
    const first = await connect();
    const second = await connect();

    const ended = await send(`/tenants/${digdir}/design-connector/grants`, 'kari', {
      method: 'DELETE',
    });
    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: second.refresh_token,
      client_id: second.clientId,
    });

    expect(ended.status).toBe(200);
    expect((await mcp(first.access_token, 'tools/list')).status).toBe(401);
    expect((await mcp(second.access_token, 'tools/list')).status).toBe(401);
    expect(refreshed.status).toBe(400);
  });

  it('refuses a code issued before «Koble fra»', async () => {
    const { register, authorize, approve, send, token } = await boot();
    const client = (await (await register()).json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const code = await approve(
      await authorize({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: claudeCallback,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    );

    await send(`/tenants/${digdir}/design-connector/grants`, 'kari', { method: 'DELETE' });
    const swapped = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: claudeCallback,
      code_verifier: verifier,
      client_id: client.client_id,
    });

    expect(swapped.status).toBe(400);
  });

  it('revokes a grant only for the client it was issued to and only with a live token', async () => {
    const { connect, mcp, outside } = await boot();
    const mine = await connect();
    const theirs = await connect();
    const revoke = (token: string, clientId: string) =>
      outside('/oauth/design/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, client_id: clientId }).toString(),
      });
    const grantId = mine.access_token.split('.')[0] ?? '';

    await revoke(mine.access_token, theirs.clientId);
    await revoke(`${grantId}.${'A'.repeat(43)}`, mine.clientId);
    const stillLive = (await mcp(mine.access_token, 'tools/list')).status;
    const revoked = await revoke(mine.refresh_token, mine.clientId);

    expect(stillLive).toBe(200);
    expect(revoked.status).toBe(200);
    expect((await mcp(mine.access_token, 'tools/list')).status).toBe(401);
    expect((await mcp(theirs.access_token, 'tools/list')).status).toBe(200);
  });

  it('answers only on the API origin, not on another host the API serves', async () => {
    const { connector } = await boot();

    expect(connector.handles(new URL(`${settings.origin}/mcp/design`))).toBe(true);
    expect(connector.handles(new URL('https://portal.genki.test/mcp/design'))).toBe(false);
    expect(connector.handles(new URL(`${settings.origin}/tenants/x/blocks`))).toBe(false);
  });

  it('ends the grant on refresh once Block Studio is off for the person', async () => {
    const { connect, token, mcp, send } = await boot();
    const first = await connect();
    await send(`/tenants/${digdir}/me/flags/blockStudio`, 'kari', {
      method: 'PUT',
      body: { on: false },
      reason: 'Slår av Utforming igjen',
    });

    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: first.clientId,
    });

    expect(refreshed.status).toBe(400);
    expect((await refreshed.json()) as { error: string }).toMatchObject({ error: 'invalid_grant' });
    expect((await mcp(first.access_token, 'tools/list')).status).toBe(401);
  });

  it('ends the grant on refresh when the person it acts for lacks manage-services', async () => {
    const { connect, token, store } = await boot();
    const first = await connect();
    const grantId = first.access_token.split('.')[0] ?? '';
    await store.update(digdir, hash('grant', grantId), async (row) => {
      const grant = JSON.parse(row.payload) as Grant;
      const narrowed = {
        ...grant,
        principal: {
          ...grant.principal,
          authorizedFor: grant.principal.authorizedFor?.map((a) => ({
            ...a,
            actions: ['use-services'],
          })),
        },
      };
      return { ...row, payload: JSON.stringify(narrowed) };
    });

    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: first.clientId,
    });

    expect(refreshed.status).toBe(400);
  });

  it('refuses tokens from an address after too many unknown ones, before looking them up', async () => {
    const { connect, outside, store } = await boot();
    const { access_token } = await connect();
    const call = (bearer: string) =>
      outside('/mcp/design', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bearer}`,
          'x-forwarded-for': '203.0.113.7',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });

    for (let i = 0; i <= limits.failedLookupsPerMinute; i++)
      expect((await call(`guess-${i}`)).status).toBe(401);
    let reads = 0;
    const get = store.get.bind(store);
    store.get = async (...args) => {
      reads++;
      return get(...args);
    };
    const blocked = await call('guess-again');
    const evenTheRightOne = await call(access_token);

    expect(blocked.status).toBe(429);
    expect(evenTheRightOne.status).toBe(429);
    expect(reads).toBe(0);
  });

  it('limits the imports one grant may send in a minute', async () => {
    const { connect, callTool } = await boot();
    const { access_token } = await connect();

    const answers = [];
    for (let i = 0; i <= limits.importsPerMinute; i += 1)
      answers.push(
        await callTool(access_token, 'import_design', { name: 'X', html: '<script></script>' }),
      );

    expect(answers.at(-2)?.text).not.toContain('Too many imports');
    expect(answers.at(-1)?.text).toContain('Too many imports');
  });

  it('refuses an MCP request over 1 MiB', async () => {
    const { connect, outside } = await boot();
    const { access_token } = await connect();

    const response = await outside('/mcp/design', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${access_token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'import_design', arguments: { name: 'X', html: 'a'.repeat(1024 * 1024) } },
      }),
    });

    expect(response.status).toBe(413);
  });
});

describe('the design connector settings', () => {
  it('stays off until the public API address and the portal are set', () => {
    expect(designConnectorFrom({}, settings.portal)).toBeUndefined();
    expect(
      designConnectorFrom({ GENAI_PUBLIC_API_URL: settings.origin }, undefined),
    ).toBeUndefined();
  });

  it('refuses a public API address that is not https, outside dev mode on localhost', () => {
    expect(() =>
      designConnectorFrom({ GENAI_PUBLIC_API_URL: 'http://api.genki.test' }, settings.portal),
    ).toThrow(/https/);
    expect(() =>
      designConnectorFrom(
        { GENAI_PUBLIC_API_URL: 'http://localhost:8080', GENAI_DEV_MODE: 'false' },
        settings.portal,
      ),
    ).toThrow(/https/);
    expect(
      designConnectorFrom(
        { GENAI_PUBLIC_API_URL: 'http://localhost:8080', GENAI_DEV_MODE: 'true' },
        settings.portal,
      )?.resource,
    ).toBe('http://localhost:8080/mcp/design');
  });
});

describe('acting for a grant', () => {
  const kari = people.kari as Principal;

  it('authenticates only the requests the connector made, never another one in the same context', () => {
    actAsConnector(kari, (nonce) => {
      const own = new Request('https://api.genki.test/x', {
        headers: { [connectorHeader]: nonce },
      });
      const other = new Request('https://api.genki.test/x');
      const guessed = new Request('https://api.genki.test/x', {
        headers: { [connectorHeader]: 'A'.repeat(nonce.length) },
      });

      expect(connectorCaller(own)?.principal).toBe(kari);
      expect(connectorCaller(other)).toBeUndefined();
      expect(connectorCaller(guessed)).toBeUndefined();
    });
    expect(connectorCaller(new Request('https://api.genki.test/x'))).toBeUndefined();
  });
});
