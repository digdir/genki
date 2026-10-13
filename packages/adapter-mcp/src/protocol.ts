export const protocolVersion = '2026-07-28';
export const handshakeVersions = ['2025-06-18'];
export const supportedVersions = [protocolVersion, ...handshakeVersions];

export const negotiatedVersion = (requested: unknown) =>
  typeof requested === 'string' && handshakeVersions.includes(requested)
    ? requested
    : (handshakeVersions[0] as string);
export const protocolVersionMetaKey = 'io.modelcontextprotocol/protocolVersion';
export const discoverTtlMs = 3_600_000;
export const toolsListTtlMs = 60_000;

export type JsonRpcId = string | number | null;

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export interface JsonRpcResult {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: Record<string, unknown>;
}

export const result = (id: JsonRpcId, body: Record<string, unknown>): JsonRpcResult => ({
  jsonrpc: '2.0',
  id,
  result: { resultType: 'complete', ...body },
});

export const rpcError = (
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError => ({
  jsonrpc: '2.0',
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

export const parseError = (message?: string) => rpcError(null, -32700, message ?? 'Parse error');
export const methodNotFound = (id: JsonRpcId, method: unknown) =>
  rpcError(id, -32601, 'Method not found', { method });
export const invalidParams = (id: JsonRpcId, message?: string, data?: unknown) =>
  rpcError(id, -32602, message ?? 'Invalid params', data);
export const internalError = (id: JsonRpcId, message?: string, data?: unknown) =>
  rpcError(id, -32603, message ?? 'Internal error', data);
const headerMismatch = (id: JsonRpcId, message: string) => rpcError(id, -32020, message);
const unsupportedVersion = (id: JsonRpcId, requested: string) =>
  rpcError(id, -32022, 'Unsupported protocol version', {
    supported: supportedVersions,
    requested,
  });

interface MetadataRule {
  header: string;
  required: 'always' | string[];
  mirrors: string[][];
  mirrorOptional?: boolean;
  mirrorDescription: string;
  allowedValues?: string[];
  base64?: boolean;
}

export const requestMetadataContract: MetadataRule[] = [
  {
    header: 'MCP-Protocol-Version',
    required: 'always',
    mirrors: [['params', '_meta', protocolVersionMetaKey]],
    mirrorOptional: true,
    mirrorDescription: `body _meta '${protocolVersionMetaKey}' value`,
    allowedValues: supportedVersions,
  },
  {
    header: 'Mcp-Method',
    required: 'always',
    mirrors: [['method']],
    mirrorDescription: 'body method',
  },
  {
    header: 'Mcp-Name',
    required: ['tools/call', 'resources/read', 'prompts/get'],
    mirrors: [
      ['params', 'name'],
      ['params', 'uri'],
    ],
    mirrorDescription: 'body value',
    base64: true,
  },
];

const decodeSentinel = (value: string) => {
  const prefix = '=?base64?';
  const suffix = '?=';
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return value;
  if (value.length <= prefix.length + suffix.length) return value;
  const decoded = Buffer.from(value.slice(prefix.length, -suffix.length), 'base64').toString(
    'utf8',
  );
  return decoded.length > 0 ? decoded : value;
};

const at = (body: unknown, path: string[]): unknown =>
  path.reduce<unknown>(
    (v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined),
    body,
  );

const display = (v: unknown) => (v === undefined || v === null ? '' : String(v));

export const validateRequest = (
  headers: Headers,
  body: Record<string, unknown>,
): { status: number; error: JsonRpcError } | undefined => {
  const id = (body.id ?? null) as JsonRpcId;
  const method = typeof body.method === 'string' ? body.method : undefined;
  if (method === 'initialize') return undefined;
  const version = headers.get('MCP-Protocol-Version');
  const handshake = version !== null && handshakeVersions.includes(version);
  for (const rule of requestMetadataContract) {
    if (handshake && rule.header !== 'MCP-Protocol-Version') continue;
    const applies =
      rule.required === 'always' || (method !== undefined && rule.required.includes(method));
    if (!applies) continue;
    const raw = headers.get(rule.header);
    const value = raw !== null && rule.base64 ? decodeSentinel(raw) : raw;
    const mirrored = rule.mirrors
      .map((p) => at(body, p))
      .find((v) => v !== undefined && v !== null);
    if (value === null) {
      const forMethod = rule.required === 'always' ? '' : ` (required for ${method})`;
      return {
        status: 400,
        error: headerMismatch(id, `Missing required header: ${rule.header}${forMethod}`),
      };
    }
    if (!(rule.mirrorOptional && mirrored === undefined) && value !== mirrored) {
      return {
        status: 400,
        error: headerMismatch(
          id,
          `Header mismatch: ${rule.header} header '${value}' does not match ${rule.mirrorDescription} '${display(mirrored)}'`,
        ),
      };
    }
    if (rule.allowedValues && !rule.allowedValues.includes(value)) {
      return { status: 400, error: unsupportedVersion(id, value) };
    }
  }
  return undefined;
};
