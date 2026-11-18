import { describe, expect, it } from 'vitest';
import { A2aProtocolError } from '@genai/providers-a2a-client';
import {
  EgressError,
  McpProtocolError,
  McpToolListError,
  SecretBindingError,
  SecretNamespaceError,
} from '@genai/providers-mcp-client';
import { OpenApiError } from '@genai/providers-openapi-tools';
import { redactSecrets, syncFailureMessage, syncFailureOf } from './sync-errors.js';

const quickly = (run: () => unknown) => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

describe('sync error redaction', () => {
  it('replaces every copy of the connection secret', () => {
    expect(redactSecrets('key abc123 refused, abc123 again', ['abc123'])).toBe(
      'key [redacted] refused, [redacted] again',
    );
  });

  it('replaces a bearer token even when the secret is unknown', () => {
    expect(redactSecrets('sent Authorization: Bearer xyz.987; refused', [])).toBe(
      'sent Authorization: Bearer [redacted]; refused',
    );
  });

  it('replaces long token-shaped strings and keeps ordinary text', () => {
    expect(
      redactSecrets('the tool server answered HTTP 503 for eyJhbGciOiJIUzI1NiJ9abcdefghijkl', []),
    ).toBe('the tool server answered HTTP 503 for [redacted]');
  });

  it('runs in linear time on long runs of token characters and spaces', () => {
    expect(
      quickly(() => redactSecrets('a'.repeat(31) + ' '.repeat(1) + 'a'.repeat(100_000), [])),
    ).toBeLessThan(1000);
    expect(quickly(() => redactSecrets('Bearer' + ' '.repeat(100_000), []))).toBeLessThan(1000);
    expect(quickly(() => redactSecrets('a!'.repeat(100_000), []))).toBeLessThan(1000);
  });
});

describe('sync failure codes', () => {
  it.each([
    ['a refused token endpoint', new EgressError('network', 'x', 401), 'auth_failed'],
    ['a tool server answering 401', new McpProtocolError('x', 401), 'auth_failed'],
    ['a tool server answering 403', new McpProtocolError('x', 403), 'auth_failed'],
    ['an agent answering 401', new A2aProtocolError('x', undefined, 401), 'auth_failed'],
    [
      'a secret not bound to the host',
      new SecretBindingError(['https://a.example']),
      'secret_unavailable',
    ],
    ['a secret of another tenant', new SecretNamespaceError('x'), 'secret_unavailable'],
    ['an address off the allowlist', new EgressError('not_allowed', 'x'), 'blocked'],
    ['a private address', new EgressError('private_address', 'x'), 'blocked'],
    ['a redirect', new EgressError('redirect_refused', 'x'), 'blocked'],
    ['a host that does not resolve', new EgressError('network', 'x'), 'unreachable'],
    ['an egress timeout', new EgressError('timeout', 'x'), 'timeout'],
    ['the sync deadline', new EgressError('cancelled', 'x'), 'timeout'],
    ['an aborted signal', new DOMException('x', 'TimeoutError'), 'timeout'],
    ['a tool server answering 503', new McpProtocolError('x', 503), 'protocol_error'],
    ['a JSON-RPC error', new McpProtocolError('x'), 'protocol_error'],
    ['a response too large', new EgressError('too_large', 'x'), 'protocol_error'],
    ['a tool list with too many pages', new McpToolListError('x'), 'tool_list_invalid'],
    ['an invalid OpenAPI document', new OpenApiError('x'), 'tool_list_invalid'],
  ] as const)('maps %s to its code', (_, error, code) => {
    expect(syncFailureOf(error)).toBe(code);
  });

  it('maps any other error to unknown, whatever its text says', () => {
    expect(syncFailureOf(new Error('HTTP 401 unauthorized, timeout'))).toBe('unknown');
    expect(syncFailureOf(new McpProtocolError('the tool server answered HTTP 401'))).toBe(
      'protocol_error',
    );
    expect(syncFailureOf('timeout')).toBe('unknown');
  });

  it('gives an unknown stored code the sentence for unknown', () => {
    expect(syncFailureMessage('something-else')).toBe(syncFailureMessage('unknown'));
  });
});
