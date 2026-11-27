import type { T } from '../../i18n';
import type { AuditEntry } from '../../types';
import { labelOf } from '../Audit';
import { personOf } from '../queue/lanes';

export const fromDigdir = (e: AuditEntry) => e.actor.startsWith('operator:');

export const auditLine = (e: AuditEntry, t: T) => {
  const label = e.actionLabel ?? labelOf(e, t);
  const what = e.target && !/^[a-z][a-z-]*:\S/.test(e.target) ? `${label}: ${e.target}` : label;
  const who = e.actorName ?? personOf(e.actor);
  const digdir = fromDigdir(e);
  return {
    sentence: digdir || !who ? what : `${who} ${what.charAt(0).toLowerCase()}${what.slice(1)}`,
    who: digdir ? who : undefined,
    reason: e.reason || undefined,
  };
};
