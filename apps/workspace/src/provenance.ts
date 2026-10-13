import { createFormat, type Format } from '@genai/i18n';
import { translator, type T } from './i18n';
import type { Part, Provenance } from './types';

export const PROVENANCE_MIME = 'application/vnd.genai.provenance+json';

const isProvenance = (value: unknown): value is Provenance =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { task?: unknown }).task === 'string' &&
  Array.isArray((value as { sources?: unknown }).sources);

export const provenanceOf = (parts: Part[]): Provenance | undefined => {
  const part = parts.find((p) => p.mime === PROVENANCE_MIME && p.body.kind === 'json');
  const json = part?.body.kind === 'json' ? part.body.json : undefined;
  return isProvenance(json) ? json : undefined;
};

export const textOf = (parts: Part[]) =>
  parts.flatMap((p) => (p.mime.startsWith('text/') && p.body.kind === 'text' ? [p.body.text] : []));

export const provenanceFooter = (
  provenance: Provenance,
  context: { serviceName: string; createdAt: Date; sourceLabels: Record<string, string> },
  t: T = translator('nb'),
  f: Format = createFormat(t.locale),
) => {
  const version = provenance.service?.capability.version;
  const basis = provenance.sources.map((id) => context.sourceLabels[id] ?? id);
  const service = context.serviceName;
  return [
    provenance.approved
      ? t('document.footerApproved', { service })
      : t('document.footerDraft', { service }),
    ...(version ? [t('document.footerVersion', { version })] : []),
    t('document.footerAt', { when: f.dateTime(context.createdAt) }),
  ]
    .join(', ')
    .concat(basis.length ? t('document.footerBasis', { sources: f.list(basis) }) : '');
};
