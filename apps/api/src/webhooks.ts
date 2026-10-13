import { randomUUID } from 'node:crypto';
import { SIGNATURE_HEADER, signWebhook, webhookSecretRef } from '@genai/composition';
import type { FeedbackStore } from '@genai/eval';
import {
  InMemoryWebhookDeliveries,
  type ClientStore,
  type StoredClient,
  type WebhookDelivery,
  type WebhookDeliveryStore,
  type WebhookEvent,
} from '@genai/identity';
import type { EventLog, SecretResolver, TaskStore } from '@genai/kernel';
import { EgressGuard, type EgressOptions } from '@genai/providers-mcp-client';

export {
  SIGNATURE_HEADER,
  signWebhook,
  verifyWebhookSignature,
  webhookSecretRef,
} from '@genai/composition';
export type { WebhookDelivery };

export type WebhookSender = (
  url: string,
  init: { headers: Record<string, string>; body: string },
) => Promise<{ status: number }>;

export const egressSender = (options: EgressOptions = {}): WebhookSender => {
  const guard = new EgressGuard({
    maxResponseBytes: 64 * 1024,
    timeoutMs: 5000,
    maxRedirects: 0,
    ...options,
  });
  return async (target, init) => {
    const url = new URL(target);
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return guard.request([{ host, port }], target, {
      method: 'POST',
      headers: init.headers,
      body: init.body,
    });
  };
};

export interface WebhookOptions {
  clients: ClientStore;
  secrets: SecretResolver;
  deliveries?: WebhookDeliveryStore;
  send?: WebhookSender;
  now?: () => Date;
  newId?: () => string;
}

const serviceOfCapability = (capability: string) => capability.split('/')[1];

export const createWebhooks = (options: WebhookOptions) => {
  const send = options.send ?? egressSender();
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());
  const store = options.deliveries ?? new InMemoryWebhookDeliveries();

  const remember = async (delivery: WebhookDelivery) => {
    await store.record(delivery).catch(() => undefined);
    return delivery;
  };

  const deliver = async (
    client: StoredClient,
    event: WebhookEvent | 'ping',
    data: Record<string, unknown>,
  ): Promise<WebhookDelivery> => {
    const { tenant, id } = client.definition.metadata;
    const hook = client.definition.spec.webhook;
    const at = now();
    const delivery = { id: newId(), tenant, client: id, event, at: at.toISOString() };
    if (!hook) return remember({ ...delivery, ok: false, error: 'no webhook is configured' });
    let secret: string;
    try {
      secret = await options.secrets.resolve(webhookSecretRef(tenant, hook.secret));
    } catch {
      return remember({ ...delivery, ok: false, error: `the secret ${hook.secret} is not set` });
    }
    const body = JSON.stringify({
      id: delivery.id,
      event,
      at: delivery.at,
      tenant,
      client: id,
      data,
    });
    try {
      const response = await send(hook.url, {
        headers: {
          'content-type': 'application/json',
          'genai-event': event,
          'genai-delivery': delivery.id,
          [SIGNATURE_HEADER]: signWebhook(secret, Math.floor(at.getTime() / 1000), body),
        },
        body,
      });
      const ok = response.status >= 200 && response.status < 300;
      return remember({ ...delivery, ok, status: response.status });
    } catch (error) {
      return remember({
        ...delivery,
        ok: false,
        error: error instanceof Error ? error.message : 'the delivery failed',
      });
    }
  };

  const emit = async (
    tenant: string,
    service: string,
    event: WebhookEvent,
    data: Record<string, unknown>,
    onlyClient?: string,
  ) => {
    const targets = (await options.clients.list(tenant)).filter(
      (c) =>
        c.definition.spec.service === service &&
        c.definition.spec.webhook?.events.includes(event) &&
        (onlyClient === undefined || c.definition.metadata.id === onlyClient),
    );
    return Promise.all(targets.map((c) => deliver(c, event, data)));
  };

  const observe = (log: EventLog, tasks: TaskStore): EventLog => ({
    append: async (event, scope) => {
      const stored = await log.append(event, scope);
      if (
        event.type === 'kernel.task.status' &&
        (event.data as { status?: string }).status === 'completed'
      )
        void tasks
          .get(event.task)
          .then((found) => {
            if (!found) return;
            const service = serviceOfCapability(found.task.service.capability.id);
            if (!service || found.task.service.capability.id.split('/')[0] !== found.task.owner)
              return;
            return emit(
              found.task.owner,
              service,
              'task.completed',
              { task: found.task.id, service, status: 'completed', endedAt: event.ts },
              found.principal.confinedTo?.client,
            );
          })
          .catch(() => undefined);
      return stored;
    },
    read: (task, fromSeq, isLive) => log.read(task, fromSeq, isLive),
    wake: (task) => log.wake(task),
  });

  const feedback = (store: FeedbackStore, tasks: TaskStore): FeedbackStore => ({
    save: async (record) => {
      await store.save(record);
      void tasks
        .get(record.task)
        .then((found) => {
          if (!found) return;
          const service = serviceOfCapability(found.task.service.capability.id);
          if (!service) return;
          return emit(
            found.task.owner,
            service,
            'feedback.received',
            { task: record.task, service, rating: record.rating },
            found.principal.confinedTo?.client,
          );
        })
        .catch(() => undefined);
    },
    list: (tenant, filter) => store.list(tenant, filter),
  });

  return {
    deliver,
    emit,
    observe,
    feedback,
    deliveries: (tenant: string, client: string, limit = 20) => store.recent(tenant, client, limit),
  };
};

export type Webhooks = ReturnType<typeof createWebhooks>;
