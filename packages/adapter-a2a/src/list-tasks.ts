import { stateOf, type A2aTask, type TaskState } from './protocol.js';

export interface ListQuery {
  contextId?: string;
  status?: TaskState;
  pageSize: number;
  after?: { timestamp: string; id: string };
  historyLength?: number;
  statusTimestampAfter?: string;
  includeArtifacts: boolean;
}

const states = new Set<string>([
  ...Object.values(stateOf),
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
]);

const encodeToken = (task: A2aTask) =>
  Buffer.from(JSON.stringify([task.status.timestamp ?? '', task.id])).toString('base64url');

const decodeToken = (token: string) => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    )
      return { timestamp: parsed[0], id: parsed[1] };
  } catch {
    return undefined;
  }
  return undefined;
};

export const readListQuery = (params: Record<string, unknown>): ListQuery | { error: string } => {
  const { contextId, status, pageSize, pageToken, historyLength, statusTimestampAfter } = params;
  if (contextId !== undefined && typeof contextId !== 'string')
    return { error: '`contextId` must be a string.' };
  if (status !== undefined && (typeof status !== 'string' || !states.has(status)))
    return { error: '`status` must be a TaskState.' };
  if (
    pageSize !== undefined &&
    (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)
  )
    return { error: '`pageSize` must be between 1 and 100.' };
  if (pageToken !== undefined && typeof pageToken !== 'string')
    return { error: '`pageToken` must be a string.' };
  const after = pageToken ? decodeToken(pageToken) : undefined;
  if (pageToken && !after) return { error: '`pageToken` is not valid.' };
  if (
    historyLength !== undefined &&
    (typeof historyLength !== 'number' || !Number.isInteger(historyLength) || historyLength < 0)
  )
    return { error: '`historyLength` must be a non-negative integer.' };
  if (
    statusTimestampAfter !== undefined &&
    (typeof statusTimestampAfter !== 'string' || Number.isNaN(Date.parse(statusTimestampAfter)))
  )
    return { error: '`statusTimestampAfter` must be an ISO 8601 timestamp.' };
  if (params.includeArtifacts !== undefined && typeof params.includeArtifacts !== 'boolean')
    return { error: '`includeArtifacts` must be a boolean.' };
  return {
    ...(contextId ? { contextId } : {}),
    ...(status ? { status: status as TaskState } : {}),
    pageSize: (pageSize as number | undefined) ?? 50,
    ...(after ? { after } : {}),
    ...(historyLength === undefined ? {} : { historyLength: historyLength as number }),
    ...(statusTimestampAfter ? { statusTimestampAfter: statusTimestampAfter as string } : {}),
    includeArtifacts: params.includeArtifacts === true,
  };
};

const timeOf = (task: A2aTask) => Date.parse(task.status.timestamp ?? '') || 0;

const newerFirst = (a: A2aTask, b: A2aTask) => timeOf(b) - timeOf(a) || b.id.localeCompare(a.id);

export const pageOf = (tasks: A2aTask[], query: ListQuery) => {
  const since = query.statusTimestampAfter ? Date.parse(query.statusTimestampAfter) : undefined;
  const matching = tasks
    .filter((t) => !query.contextId || t.contextId === query.contextId)
    .filter((t) => !query.status || t.status.state === query.status)
    .filter((t) => since === undefined || timeOf(t) >= since)
    .sort(newerFirst);
  const cursor = query.after;
  const rest = cursor
    ? matching.filter(
        (t) =>
          newerFirst(t, {
            id: cursor.id,
            status: { state: t.status.state, timestamp: cursor.timestamp },
          }) > 0,
      )
    : matching;
  const page = rest.slice(0, query.pageSize).map((t) => {
    const { artifacts, history, ...task } = t;
    return {
      ...task,
      ...(query.includeArtifacts ? { artifacts: artifacts ?? [] } : {}),
      ...(history && query.historyLength !== 0
        ? { history: query.historyLength ? history.slice(-query.historyLength) : history }
        : {}),
    };
  });
  const last = page[page.length - 1];
  return {
    tasks: page,
    nextPageToken: last && rest.length > page.length ? encodeToken(last) : '',
    pageSize: query.pageSize,
    totalSize: matching.length,
  };
};
