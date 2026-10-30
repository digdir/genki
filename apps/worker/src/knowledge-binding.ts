import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface KnowledgeBindingWatch {
  start(): Promise<void>;
  ready(): boolean;
  knowledgeBound(): void;
  stop(): void;
}

type State =
  | { kind: 'none' }
  | { kind: 'checking' }
  | { kind: 'bound' }
  | { kind: 'unbound'; platform: string; boundTo: string | undefined }
  | { kind: 'unreachable' };

export const watchKnowledgeBinding = (options: {
  platformId: () => Promise<string>;
  boundTo?: () => Promise<string | undefined>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  intervalMs?: number;
}): KnowledgeBindingWatch => {
  const { boundTo, log } = options;
  let state: State = boundTo ? { kind: 'checking' } : { kind: 'none' };
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const check = async () => {
    if (!boundTo) return;
    const before = state.kind;
    let next: State;
    try {
      const [platform, bound] = await Promise.all([options.platformId(), boundTo()]);
      next = bound === platform ? { kind: 'bound' } : { kind: 'unbound', platform, boundTo: bound };
    } catch (error) {
      state = { kind: 'unreachable' };
      if (before !== 'unreachable')
        log('knowledge server unreachable', { level: 'error', error: String(error) });
      return;
    }
    state = next;
    if (next.kind === 'bound' && before !== 'bound')
      log('knowledge server bound to this platform server');
    if (next.kind === 'unbound' && before !== 'unbound')
      log(
        next.boundTo === undefined
          ? 'knowledge server not bound to any platform server'
          : 'knowledge server bound to another platform server',
        { level: 'error', platform: next.platform, boundTo: next.boundTo },
      );
  };

  const schedule = () => {
    if (stopped || state.kind === 'bound' || state.kind === 'none') return;
    timer = setTimeout(() => {
      void check().then(schedule);
    }, options.intervalMs ?? 60_000);
    timer.unref();
  };

  return {
    start: async () => {
      await check();
      schedule();
    },
    ready: () => state.kind === 'none' || state.kind === 'bound',
    knowledgeBound: () => {
      switch (state.kind) {
        case 'bound':
          return;
        case 'none':
          throw new Error('no knowledge server configured');
        case 'unbound':
          throw new Error(
            state.boundTo === undefined
              ? 'the knowledge server is not bound to a platform server; run its setup'
              : `the knowledge server is bound to platform server ${state.boundTo}, not ${state.platform}`,
          );
        case 'checking':
          throw new Error('the knowledge server binding has not been checked yet');
        case 'unreachable':
          throw new Error('the knowledge server is unreachable');
      }
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
};

export const startHealthServer = async (options: {
  port: number;
  ready: () => boolean;
}): Promise<{ url: string; close: () => Promise<void> }> => {
  const server = createServer((request, response) => {
    const path = request.url?.split('?')[0];
    if (path === '/healthz') {
      response.writeHead(200).end('ok');
      return;
    }
    if (path === '/readyz') {
      const ready = options.ready();
      response.writeHead(ready ? 200 : 503).end(ready ? 'ready' : 'not ready');
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`WORKER_HEALTH_PORT ${options.port} is taken; set another port`)
          : error,
      ),
    );
    server.listen(options.port, resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

/** The knowledge pools go to the runtime only together with the binding check that guards every knowledge write. */
export const knowledgeRuntimeInput = <P>(
  server: { pools: P } | undefined,
  binding: KnowledgeBindingWatch,
): { knowledgeServer?: P; knowledgeGuard?: () => void } =>
  server ? { knowledgeServer: server.pools, knowledgeGuard: () => binding.knowledgeBound() } : {};
