import type { AuditEntry } from './admin.js';

export interface FlagAuditDetail {
  key: string;
  on?: boolean | null;
  person?: { self: boolean; name?: string };
}

export type AuditWithFlag<E> = E & { flag?: FlagAuditDetail };

interface AuditEvent {
  data?: unknown;
}

const flagTarget = /^flag:([^:]+)(?::person:(.+))?$/;

export const isFlagAction = (action: string) =>
  action === 'platform.flag.person' || action === 'platform.flag.tenant';

const switchedTo = (events: AuditEvent[]): boolean | null | undefined => {
  for (const event of events) {
    const on = (event.data as { on?: unknown } | undefined)?.on;
    if (typeof on === 'boolean' || on === null) return on;
  }
  return undefined;
};

export const withFlagDetails = async <E extends AuditEntry>(
  entries: E[],
  read: {
    events?: ((task: string) => Promise<AuditEvent[]>) | undefined;
    names?: { namesOf(actors: string[]): Promise<Map<string, string>> } | undefined;
  },
): Promise<AuditWithFlag<E>[]> =>
  Promise.all(
    entries.map(async (entry) => {
      const found = isFlagAction(entry.action) ? flagTarget.exec(entry.target) : null;
      if (!found?.[1]) return entry;
      const on = await read.events?.(entry.task).then(switchedTo, () => undefined);
      const subject = found[2] ? `employee:${found[2]}` : undefined;
      const name = subject ? (await read.names?.namesOf([subject]))?.get(subject) : undefined;
      const flag: FlagAuditDetail = {
        key: found[1],
        ...(on === undefined ? {} : { on }),
        ...(subject
          ? { person: { self: subject === entry.actor, ...(name ? { name } : {}) } }
          : {}),
      };
      return { ...entry, flag };
    }),
  );
