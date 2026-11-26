import type { Translation } from '@genai/i18n';
import type { designConnector as nb } from '../nb/design-connector.js';

export const designConnector = {
  authorizeRefusedTitle: 'Could not connect Claude',
  authorizeRefusedBody:
    'The link is not valid for genki. Start connecting again from Claude, or follow the guide under «Connect Claude» in Design.',
  otherBrowserTitle: 'Connect Claude in the same browser',
  otherBrowserBody:
    'This connection was started in another browser, so genki did not finish it. Start it again from Claude in this browser.',
  decisionInvalid: 'must be allow or deny',
  requestGone: 'The connection has expired or was already used. Start it again from Claude.',
} satisfies Translation<typeof nb>;
