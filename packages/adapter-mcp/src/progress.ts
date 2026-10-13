import type { Event } from '@genai/contracts';

type Fields = Record<string, unknown>;

const compact = (m: Fields) =>
  Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined && v !== null));

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

const messages: Record<string, (d: Fields) => { message: string; total?: unknown; meta: Fields }> =
  {
    'stage/started': (d) => ({
      message: str(d.label) || `Stage ${str(d.stage)}`,
      meta: compact({ event: 'stage/started', stage: d.stage }),
    }),
    'stage/completed': (d) => ({
      message: str(d.label) || `Stage ${str(d.stage)} complete`,
      meta: compact({ event: 'stage/completed', stage: d.stage, 'duration-ms': d['duration-ms'] }),
    }),
    'step/skipped': (d) => ({
      message: `Step ${str(d['skill-id'] ?? d['step-id'])} skipped`,
      meta: compact({
        event: 'step/skipped',
        'step-id': d['step-id'],
        'skill-id': d['skill-id'],
        'duration-ms': d['duration-ms'],
      }),
    }),
    'step/defaulted': (d) => ({
      message: `Step ${str(d['skill-id'] ?? d['step-id'])} defaulted`,
      meta: compact({
        event: 'step/defaulted',
        'step-id': d['step-id'],
        'skill-id': d['skill-id'],
        'duration-ms': d['duration-ms'],
      }),
    }),
    'tool/call': (d) => ({
      message: `Tool call: ${str((d['tool-call'] as Fields | undefined)?.tool)}`,
      meta: { event: 'tool/call', 'tool-call': d['tool-call'] },
    }),
    'tool/result': (d) => ({
      message: `Tool result: ${str((d['tool-result'] as Fields | undefined)?.tool)}`,
      meta: { event: 'tool/result', 'tool-result': d['tool-result'] },
    }),
    'agent/iteration-started': (d) => ({
      message: `Iteration ${str(d.iteration)} of ${str(d['max-iterations'])}`,
      total: d['max-iterations'],
      meta: {
        event: 'agent/iteration-started',
        iteration: d.iteration,
        'max-iterations': d['max-iterations'],
      },
    }),
    'agent/thinking': (d) => ({
      message: 'Reasoning…',
      meta: compact({ event: 'agent/thinking', iteration: d.iteration, reasoning: d.reasoning }),
    }),
    'agent/turn-completed': (d) => ({
      message: `Turn ${str(d.iteration)} complete`,
      meta: {
        event: 'agent/turn-completed',
        iteration: d.iteration,
        'tool-calls': d['tool-calls'],
      },
    }),
    'agent/finalized': (d) => ({
      message: 'Response finalized',
      meta: compact({
        event: 'agent/finalized',
        iteration: d.iteration,
        'response-length': d['response-length'],
      }),
    }),
    'warning/raised': (d) => ({
      message: str((d.warning as Fields | undefined)?.message) || 'Warning',
      meta: { event: 'warning/raised', warning: d.warning },
    }),
  };

export const progressTracker = (token: unknown, query: string | undefined) => {
  let counter = 0;
  let started = false;
  const frame = (params: Fields) => ({
    jsonrpc: '2.0' as const,
    method: 'notifications/progress',
    params: { progressToken: token, progress: ++counter, ...params },
  });

  const shaped = (data: Fields) => {
    const shape = messages[String(data.event)];
    if (!shape) return undefined;
    const { message, total, meta } = shape(data);
    return frame({ ...(total === undefined ? {} : { total }), message, _meta: meta });
  };
  let iterating: number | undefined;
  const stage = (event: 'stage/started' | 'stage/completed', id: string, label: string) =>
    shaped({
      event,
      stage: id,
      label: event === 'stage/started' ? label : `${label} complete`,
      ...(event === 'stage/completed' && iterating !== undefined
        ? { 'duration-ms': Date.now() - iterating }
        : {}),
    });

  const frames = (event: Event): unknown[] => {
    if (event.audience === 'audit') return [];
    const data = (event.data ?? {}) as Fields;
    if (event.type === 'kernel.task.status' && data.status === 'running' && !started) {
      started = true;
      return [
        frame({
          message: 'Request started',
          _meta: compact({ event: 'request/started', 'request-id': event.task, query }),
        }),
      ];
    }
    if (event.type === 'kernel.part.delta' && typeof data.text === 'string')
      return [frame({ message: data.text, _meta: { event: 'response/chunk', delta: data.text } })];
    if (event.type !== 'kernel.notice') return [];
    if (data.stage === 'exhausted')
      return [
        shaped({
          event: 'warning/raised',
          warning: { code: 'agent-exhausted', message: 'Agent reached max iterations' },
        }),
      ];
    if (typeof data.event !== 'string') return [];
    const out: unknown[] = [];
    if (data.event === 'agent/iteration-started' && iterating === undefined) {
      out.push(stage('stage/started', 'agent-iteration', 'Agent Iterate'));
      iterating = Date.now();
    }
    if (data.event === 'agent/turn-completed' && Array.isArray(data['tool-calls']))
      for (const call of data['tool-calls'] as Fields[])
        out.push(
          shaped({
            event: 'tool/result',
            'tool-result': {
              tool: call.tool,
              summary: call['result-summary'],
              'ok?': call['ok?'],
              iteration: data.iteration,
            },
          }),
        );
    if (data.event === 'agent/finalized' && iterating !== undefined)
      out.push(stage('stage/completed', 'agent-iteration', 'Agent Iterate'));
    out.push(shaped(data));
    return out.filter((f) => f !== undefined);
  };
  return frames;
};
