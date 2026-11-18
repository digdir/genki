import { A2aProtocolError } from '@genai/providers-a2a-client';
import {
  EgressError,
  McpProtocolError,
  McpToolListError,
  SecretBindingError,
  SecretNamespaceError,
} from '@genai/providers-mcp-client';
import { OpenApiError } from '@genai/providers-openapi-tools';
import { t, type ApiKey } from './i18n/index.js';

const redacted = '[redacted]';
const bearer = /\bBearer\s+[^\s"',;]+/gi;
const tokenLike = /[A-Za-z0-9_\-.+/=]{32,}/g;

export const redactSecrets = (text: string, secrets: readonly string[]) => {
  let out = text;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join(redacted);
  return out.replace(bearer, `Bearer ${redacted}`).replace(tokenLike, redacted);
};

export const syncFailureCodes = [
  'auth_failed',
  'secret_unavailable',
  'blocked',
  'unreachable',
  'timeout',
  'protocol_error',
  'tool_list_invalid',
  'unknown',
] as const;

export type SyncFailureCode = (typeof syncFailureCodes)[number];

const refusesCredentials = (status: number | undefined) =>
  status === 400 || status === 401 || status === 403;

export const syncFailureOf = (error: unknown): SyncFailureCode => {
  if (error instanceof SecretBindingError || error instanceof SecretNamespaceError)
    return 'secret_unavailable';
  if (error instanceof EgressError) {
    if (error.code === 'timeout' || error.code === 'cancelled') return 'timeout';
    if (error.code === 'network')
      return refusesCredentials(error.status) ? 'auth_failed' : 'unreachable';
    if (error.code === 'too_large') return 'protocol_error';
    return 'blocked';
  }
  if (error instanceof McpToolListError || error instanceof OpenApiError)
    return 'tool_list_invalid';
  if (error instanceof McpProtocolError || error instanceof A2aProtocolError)
    return error.status === 401 || error.status === 403 ? 'auth_failed' : 'protocol_error';
  if (
    error instanceof DOMException &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  )
    return 'timeout';
  return 'unknown';
};

const messageKeys: Record<SyncFailureCode, ApiKey> = {
  auth_failed: 'blockErrors.toolSyncAuthFailed',
  secret_unavailable: 'blockErrors.toolSyncSecretUnavailable',
  blocked: 'blockErrors.toolSyncBlocked',
  unreachable: 'blockErrors.toolSyncUnreachable',
  timeout: 'blockErrors.toolSyncTimeout',
  protocol_error: 'blockErrors.toolSyncProtocolError',
  tool_list_invalid: 'blockErrors.toolSyncToolListInvalid',
  unknown: 'blockErrors.toolSyncUnknown',
};

const isSyncFailureCode = (code: string): code is SyncFailureCode =>
  (syncFailureCodes as readonly string[]).includes(code);

export const syncFailureMessage = (code: string) =>
  t(messageKeys[isSyncFailureCode(code) ? code : 'unknown'] as 'blockErrors.toolSyncUnknown');
