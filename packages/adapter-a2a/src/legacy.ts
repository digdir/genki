import type { A2aMessage, A2aPart, A2aTask, TaskState } from './protocol.js';

export const legacyVersion = '0.3';

export const legacyMethods: Record<string, string> = {
  'message/send': 'SendMessage',
  'message/stream': 'SendStreamingMessage',
  'tasks/get': 'GetTask',
  'tasks/cancel': 'CancelTask',
  'tasks/resubscribe': 'SubscribeToTask',
  'tasks/pushNotificationConfig/set': 'CreateTaskPushNotificationConfig',
  'tasks/pushNotificationConfig/get': 'GetTaskPushNotificationConfig',
  'tasks/pushNotificationConfig/list': 'ListTaskPushNotificationConfigs',
  'tasks/pushNotificationConfig/delete': 'DeleteTaskPushNotificationConfig',
  'agent/getAuthenticatedExtendedCard': 'GetExtendedAgentCard',
};

const legacyStates: Record<TaskState, string> = {
  TASK_STATE_SUBMITTED: 'submitted',
  TASK_STATE_WORKING: 'working',
  TASK_STATE_COMPLETED: 'completed',
  TASK_STATE_FAILED: 'failed',
  TASK_STATE_CANCELED: 'canceled',
  TASK_STATE_INPUT_REQUIRED: 'input-required',
  TASK_STATE_REJECTED: 'rejected',
  TASK_STATE_AUTH_REQUIRED: 'auth-required',
};

const finalStates = new Set<TaskState>([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const fromLegacyPart = (part: unknown): unknown => {
  if (!isRecord(part)) return part;
  const metadata = isRecord(part.metadata) ? { metadata: part.metadata } : {};
  if (part.kind === 'text') return { text: part.text, ...metadata };
  if (part.kind === 'data') return { data: part.data, ...metadata };
  if (part.kind === 'file') {
    const file = isRecord(part.file) ? part.file : {};
    return {
      ...(file.uri !== undefined ? { url: file.uri } : { raw: file.bytes ?? '' }),
      ...(typeof file.mimeType === 'string' ? { mediaType: file.mimeType } : {}),
      ...(typeof file.name === 'string' ? { filename: file.name } : {}),
      ...metadata,
    };
  }
  return part;
};

export const fromLegacyParams = (params: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...params };
  const message = params.message;
  if (isRecord(message)) {
    out.message = {
      ...message,
      role:
        message.role === 'user'
          ? 'ROLE_USER'
          : message.role === 'agent'
            ? 'ROLE_AGENT'
            : message.role,
      ...(Array.isArray(message.parts) ? { parts: message.parts.map(fromLegacyPart) } : {}),
    };
  }
  const configuration = params.configuration;
  if (isRecord(configuration)) {
    const { blocking, ...rest } = configuration;
    out.configuration = { ...rest, ...(blocking === false ? { returnImmediately: true } : {}) };
  }
  return out;
};

const toLegacyPart = (part: A2aPart) => {
  const metadata = {
    ...(part.metadata ?? {}),
    ...(part.mediaType && (part.text !== undefined || part.data !== undefined)
      ? { mediaType: part.mediaType }
      : {}),
  };
  const meta = Object.keys(metadata).length > 0 ? { metadata } : {};
  if (part.text !== undefined) return { kind: 'text', text: part.text, ...meta };
  if (part.data !== undefined) return { kind: 'data', data: part.data, ...meta };
  return {
    kind: 'file',
    file: {
      ...(part.url !== undefined ? { uri: part.url } : { bytes: part.raw ?? '' }),
      ...(part.mediaType ? { mimeType: part.mediaType } : {}),
      ...(part.filename ? { name: part.filename } : {}),
    },
    ...meta,
  };
};

const toLegacyMessage = (message: A2aMessage) => ({
  ...message,
  kind: 'message',
  role: message.role === 'ROLE_USER' ? 'user' : 'agent',
  parts: message.parts.map(toLegacyPart),
});

const toLegacyStatus = (status: A2aTask['status']) => ({
  ...status,
  state: legacyStates[status.state],
  ...(status.message ? { message: toLegacyMessage(status.message) } : {}),
});

const toLegacyArtifact = (artifact: NonNullable<A2aTask['artifacts']>[number]) => ({
  ...artifact,
  parts: artifact.parts.map(toLegacyPart),
});

export const toLegacyTask = (task: A2aTask) => ({
  ...task,
  kind: 'task',
  status: toLegacyStatus(task.status),
  ...(task.artifacts ? { artifacts: task.artifacts.map(toLegacyArtifact) } : {}),
  ...(task.history ? { history: task.history.map(toLegacyMessage) } : {}),
});

const isTask = (v: Record<string, unknown>): v is Record<string, unknown> & A2aTask =>
  typeof v.id === 'string' && isRecord(v.status);

export const toLegacyResult = (result: unknown): unknown => {
  if (!isRecord(result)) return result;
  if (isRecord(result.task)) return toLegacyTask(result.task as unknown as A2aTask);
  if (isRecord(result.message)) return toLegacyMessage(result.message as unknown as A2aMessage);
  if (isRecord(result.statusUpdate)) {
    const update = result.statusUpdate as { status: A2aTask['status'] } & Record<string, unknown>;
    return {
      ...update,
      kind: 'status-update',
      status: toLegacyStatus(update.status),
      final: finalStates.has(update.status.state),
    };
  }
  if (isRecord(result.artifactUpdate)) {
    const update = result.artifactUpdate as {
      artifact: NonNullable<A2aTask['artifacts']>[number];
    } & Record<string, unknown>;
    return { ...update, kind: 'artifact-update', artifact: toLegacyArtifact(update.artifact) };
  }
  if (isTask(result)) return toLegacyTask(result);
  return result;
};
