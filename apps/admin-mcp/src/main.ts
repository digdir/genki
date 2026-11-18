import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type RequestId,
  type Transport,
} from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { genkiClient, isLoopback, requireSafeUrl, type GenkiClient } from './client.js';
import { devLoginSource, sessionToken } from './login.js';
import { createAdminServer } from './protocol.js';
import { toolsFor } from './tools.js';

const log = (text: string) => process.stderr.write(`[genki-admin] ${text}\n`);

const openBrowser = (url: string) => {
  log(`log in to genki in the browser: ${url}`);
  const [command, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['rundll32', 'url.dll,FileProtocolHandler', url]
        : ['xdg-open', url];
  spawn(command as string, args, { stdio: 'ignore', detached: true })
    .on('error', () => undefined)
    .unref();
};

const env = (name: string) => process.env[name]?.trim() || undefined;

const required = (name: string) => {
  const value = env(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const flag = (name: string, fallback: boolean) => {
  const value = env(name);
  return value === undefined ? fallback : value === 'true';
};

const portalFor = (apiBase: string) => {
  const given = env('GENKI_PORTAL_URL');
  if (given) return requireSafeUrl('GENKI_PORTAL_URL', given);
  const url = new URL(apiBase);
  if (isLoopback(apiBase) || !url.hostname.startsWith('api.')) return undefined;
  return `${url.protocol}//portal.${url.hostname.slice(4)}`;
};

const connect = (): GenkiClient => {
  const devLogin = env('GENKI_DEV_LOGIN') === 'true';
  const apiBase = requireSafeUrl(
    'GENKI_API_BASE',
    devLogin ? (env('GENKI_API_BASE') ?? 'http://localhost:8080') : required('GENKI_API_BASE'),
  );
  const tenant = required('GENKI_TENANT');
  if (!/^\d{9}$/.test(tenant)) throw new Error('GENKI_TENANT must be an organisation number');
  const portal = portalFor(apiBase);
  const token = devLogin
    ? devLoginSource(apiBase)
    : sessionToken({
        issuer: requireSafeUrl(
          'ANSATTPORTEN_ISSUER',
          env('ANSATTPORTEN_ISSUER') ?? 'https://test.ansattporten.no',
        ),
        clientId: required('ADMIN_MCP_CLIENT_ID'),
        audience: env('GENKI_AUDIENCE') ?? 'digdir:genai',
        altinnResource:
          env('GENKI_ALTINN_RESOURCE') ?? 'urn:altinn:resource:digdir-genai-platform-test',
        redirectUri: env('ADMIN_MCP_REDIRECT_URI') ?? 'http://localhost:5173/callback',
        open: openBrowser,
      });
  return genkiClient({ apiBase, tenant, token, ...(portal ? { portal } : {}) });
};

const tools = toolsFor({
  readOnly: flag('GENKI_READ_ONLY', false),
  playground: flag('GENKI_PLAYGROUND', true),
});
const budgetNok = Number(env('GENKI_PLAYGROUND_BUDGET_NOK') ?? 5);
if (!Number.isFinite(budgetNok) || budgetNok < 0)
  throw new Error('GENKI_PLAYGROUND_BUDGET_NOK must be a number of kroner, 0 or more');
const spend = { budgetNok, spentNok: 0 };

let connecting: Promise<GenkiClient> | undefined;
const client = () => {
  connecting ??= Promise.resolve().then(connect);
  connecting.catch(() => {
    connecting = undefined;
  });
  return connecting;
};

const drainingStdio = (): Transport => {
  const input = new PassThrough();
  process.stdin.pipe(input, { end: false });
  const wire = new StdioServerTransport(input, process.stdout);
  const pending = new Set<RequestId>();
  let stdinEnded = false;
  const settle = (id: RequestId) => {
    pending.delete(id);
    if (stdinEnded && pending.size === 0) input.end();
  };
  process.stdin.on('end', () => {
    stdinEnded = true;
    if (pending.size === 0) input.end();
  });
  const transport: Transport = {
    start: () => wire.start(),
    close: () => wire.close(),
    send: async (message) => {
      await wire.send(message);
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message))
        if (message.id !== undefined) settle(message.id);
    },
  };
  wire.onmessage = (message) => {
    if (isJSONRPCRequest(message)) pending.add(message.id);
    transport.onmessage?.(message);
    if (isJSONRPCNotification(message) && message.method === 'notifications/cancelled') {
      const id = (message.params as { requestId?: RequestId } | undefined)?.requestId;
      if (id !== undefined) settle(id);
    }
  };
  wire.onerror = (error) => transport.onerror?.(error);
  wire.onclose = () => {
    transport.onclose?.();
    process.stdout.write('', () => process.exit(0));
  };
  return transport;
};

serveStdio(() => createAdminServer(tools, client, spend), {
  transport: drainingStdio(),
  onerror: (error) => log(error.message),
});

log(
  `ready: ${tools.length} tools${flag('GENKI_READ_ONLY', false) ? ', read-only' : ''}, playground budget ${spend.budgetNok} kr`,
);
