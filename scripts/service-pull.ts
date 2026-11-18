import { spawn } from 'node:child_process';
import { requireSafeUrl } from '../apps/admin-mcp/src/client.js';
import { devLoginSource, sessionToken } from '../apps/admin-mcp/src/login.js';
import { runPull } from '../apps/admin-mcp/src/pull-service.js';

const env = (name: string) => process.env[name]?.trim() || undefined;

const openBrowser = (url: string) => {
  console.error(`log in to genki in the browser: ${url}`);
  const [command, ...args] = process.platform === 'darwin' ? ['open', url] : ['xdg-open', url];
  spawn(command as string, args, { stdio: 'ignore', detached: true })
    .on('error', () => undefined)
    .unref();
};

const clientId = env('ADMIN_MCP_CLIENT_ID');
const token = env('GENKI_SOURCE_TOKEN');

try {
  const text = await runPull(process.argv.slice(2), {
    login: {
      ...(token ? { token } : {}),
      ...(clientId
        ? {
            browser: () =>
              sessionToken({
                issuer: requireSafeUrl(
                  'ANSATTPORTEN_ISSUER',
                  env('ANSATTPORTEN_ISSUER') ?? 'https://test.ansattporten.no',
                ),
                clientId,
                audience: env('GENKI_AUDIENCE') ?? 'digdir:genai',
                altinnResource:
                  env('GENKI_ALTINN_RESOURCE') ?? 'urn:altinn:resource:digdir-genai-platform-test',
                redirectUri: env('ADMIN_MCP_REDIRECT_URI') ?? 'http://localhost:5173/callback',
                open: openBrowser,
              }),
          }
        : {}),
    },
    localToken: (localUrl) => devLoginSource(localUrl),
  });
  console.log(text);
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
