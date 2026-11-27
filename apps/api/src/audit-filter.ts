import { z } from '@hono/zod-openapi';
import { osloDay } from './content-reason.js';

const moment = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export const auditFilterQuery = {
  from: moment.optional().openapi({
    param: { name: 'from', in: 'query' },
    description: 'Entries at or after this time; a date counts from the start of that Oslo day',
    example: '2026-09-01',
  }),
  to: moment.optional().openapi({
    param: { name: 'to', in: 'query' },
    description: 'Entries at or before this time; a date counts to the end of that Oslo day',
    example: '2026-11-25',
  }),
  actor: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .openapi({
      param: { name: 'actor', in: 'query' },
      description: 'One actor id, as in the entries',
    }),
  action: z
    .string()
    .regex(/^[a-z][a-z0-9.-]{0,99}$/)
    .optional()
    .openapi({
      param: { name: 'action', in: 'query' },
      description: 'Keep actions that start with this, such as platform.flag',
    }),
  by: z
    .enum(['operator', 'tenant'])
    .optional()
    .openapi({
      param: { name: 'by', in: 'query' },
      description: 'operator: changes an operator made; tenant: every other change',
    }),
};

export const AuditFilter = z.object(auditFilterQuery);
export type AuditFilter = z.infer<typeof AuditFilter>;

const isDate = (value: string) => value.length === 10;

const after = (at: string, from: string) =>
  isDate(from) ? osloDay(new Date(at)) >= from : Date.parse(at) >= Date.parse(from);

const before = (at: string, to: string) =>
  isDate(to) ? osloDay(new Date(at)) <= to : Date.parse(at) <= Date.parse(to);

export const auditMatches =
  (filter: AuditFilter) => (entry: { at: string; actor: string; action: string }) =>
    (filter.from === undefined || after(entry.at, filter.from)) &&
    (filter.to === undefined || before(entry.at, filter.to)) &&
    (filter.actor === undefined || entry.actor === filter.actor) &&
    (filter.action === undefined || entry.action.startsWith(filter.action)) &&
    (filter.by === undefined || entry.actor.startsWith('operator:') === (filter.by === 'operator'));
