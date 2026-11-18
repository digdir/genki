import type { FlowDefinition, ToolConnectionDetail } from '../api/blocks';
import type { MockHandler } from '../mock';

export interface BlocksMockOptions {
  connections?: ToolConnectionDetail[];
  failSync?: boolean;
  flowDefinitions?: Record<string, FlowDefinition>;
}

export const blocksMock = (options: BlocksMockOptions = {}): MockHandler => {
  let connections = structuredClone(options.connections ?? []);
  return (req) => {
    const flow = /^\/tenants\/[^/]+\/building-blocks\/step_flow\/([^/]+)\/definition$/.exec(
      req.path,
    );
    if (flow && req.method === 'GET') {
      const found = options.flowDefinitions?.[decodeURIComponent(flow[1] ?? '')];
      return found ? req.json(found) : req.notFound();
    }
    if (
      options.connections &&
      req.method === 'GET' &&
      /^\/tenants\/[^/]+\/tool-connections$/.test(req.path)
    )
      return req.json({ data: connections });
    const match = /^\/tenants\/[^/]+\/tool-connections\/([^/]+)\/(revoke|approve|sync)$/.exec(
      req.path,
    );
    if (!match || req.method !== 'POST') return undefined;
    const id = decodeURIComponent(match[1] ?? '');
    const found = connections.find((c) => c.id === id);
    if (!found) return undefined;
    if (!req.reason) return req.reasonMissing();
    if (match[2] === 'sync') {
      if (options.failSync)
        return req.json({ title: 'The sync failed', status: 400, code: 'timeout' }, 400);
      const at = new Date().toISOString();
      connections = connections.map((c) =>
        c.id === id ? { ...c, lastSync: { at, ok: true } } : c,
      );
      const details = found.toolDetails ?? [];
      return req.json({
        active: details.filter((d) => d.state === 'approved').length,
        pending: details.filter((d) => d.state === 'pending').map((d) => d.name),
      });
    }
    const { tool } = req.body<{ tool: string }>();
    const detail = found.toolDetails?.find((d) => d.name === tool);
    const revoking = match[2] === 'revoke';
    if (!detail || detail.state !== (revoking ? 'approved' : 'pending'))
      return req.json(
        { type: 'urn:genai:problem:tool-not-found', title: 'No such tool', status: 404 },
        404,
      );
    detail.state = revoking ? 'pending' : 'approved';
    return req.json(revoking ? { revoked: tool } : { approved: tool });
  };
};
