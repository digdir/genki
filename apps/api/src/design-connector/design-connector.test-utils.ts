import { InMemoryBffSessions } from '../bff/sessions.js';
import { designConnectorModule } from './consent.js';
import { createDesignConnector } from './oauth.js';
import type { DesignConnectorSettings } from './settings.js';

export const testConnectorSettings: DesignConnectorSettings = {
  origin: 'https://api.genki.test',
  resource: 'https://api.genki.test/mcp/design',
  issuer: 'https://api.genki.test/oauth/design',
  portal: 'https://portal.genki.test',
};

export const idleConnectorModule = (partition: string) =>
  designConnectorModule(
    createDesignConnector({
      settings: testConnectorSettings,
      store: new InMemoryBffSessions(),
      partition,
      inner: () => new Response(null, { status: 503 }),
    }),
    testConnectorSettings,
  );
