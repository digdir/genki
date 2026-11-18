import { useFormat } from '@genai/i18n/react';
import type { CatalogModel } from '../api/models';
import { useT, type PlainKey } from '../i18n';
import { displayName, perMillion, usable, type ModelStatus } from '../models';
import type { Residency } from '../types';

const whereKeys: Record<Residency, PlainKey> = {
  norway: 'modelWords.whereNorway',
  eu: 'modelWords.whereEu',
  global: 'modelWords.whereGlobal',
};

const statusKeys: Record<ModelStatus, PlainKey> = {
  in_use: 'modelWords.statusInUse',
  available: 'modelWords.statusAvailable',
  requires_approval: 'modelWords.statusRequiresApproval',
  pending_approval: 'modelWords.statusPendingApproval',
  not_allowed: 'modelWords.statusNotAllowed',
};

export const statusColor = (status: ModelStatus) =>
  status === 'in_use'
    ? 'info'
    : status === 'available'
      ? 'neutral'
      : status === 'not_allowed'
        ? 'danger'
        : 'warning';

const useKeys: Record<string, PlainKey> = {
  chat: 'modelWords.useChat',
  decide: 'modelWords.useDecide',
  classify: 'modelWords.useClassify',
  embed: 'modelWords.useEmbed',
  'generate-image': 'modelWords.useGenerateImage',
  transcribe: 'modelWords.useTranscribe',
  speak: 'modelWords.useSpeak',
  realtime: 'modelWords.useRealtime',
};

const capabilityKeys: Record<string, PlainKey> = {
  stream: 'modelWords.capStream',
  tools: 'modelWords.capTools',
  'json-schema': 'modelWords.capJsonSchema',
  reasoning: 'modelWords.capReasoning',
};

const fallbackWord = (kind: string) => {
  const words = kind.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : kind;
};

export const modelBlockHref = (id: string) => `#/building-blocks/model/${encodeURIComponent(id)}`;

export const useModelText = () => {
  const t = useT();
  const f = useFormat();
  const kr = (v: number) => f.number(v, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const where = (r: Residency) => t(whereKeys[r]);
  const operator = (m: CatalogModel) =>
    m.operator
      ? m.operator.region
        ? t('modelWords.operatorWithRegion', { name: m.operator.name, region: m.operator.region })
        : m.operator.name
      : '';
  const maker = (m: CatalogModel) => m.maker || t('modelWords.unknownMaker');
  return {
    t,
    f,
    name: displayName,
    where,
    dataIn: (r: Residency) =>
      r === 'global' ? t('modelWords.dataInGlobal') : t('modelWords.dataIn', { where: where(r) }),
    whereLong: (m: CatalogModel) =>
      m.residency === 'eu' && m.operator?.region
        ? `${where(m.residency)} (${m.operator.region})`
        : where(m.residency),
    status: (s: ModelStatus) => t(statusKeys[s]),
    use: (op: string) => {
      const key = useKeys[op];
      return key ? t(key) : fallbackWord(op);
    },
    uses: (m: CatalogModel) => (m.operations?.length ? m.operations : ['chat']),
    capabilities: (m: CatalogModel) =>
      m.capabilities.length
        ? m.capabilities
            .map((c) => {
              const key = capabilityKeys[c];
              return key ? t(key) : fallbackWord(c);
            })
            .join(', ')
        : t('modelWords.noCapabilities'),
    price: (m: CatalogModel) => {
      if (!m.price) return t('modelWords.notPriced');
      const p = perMillion(m.price);
      return t('modelWords.pricePerMillion', { input: kr(p.input), output: kr(p.output) });
    },
    context: (m: CatalogModel) =>
      m.contextWindow
        ? t('modelWords.contextTokens', { tokens: f.number(m.contextWindow) })
        : t('modelWords.notStated'),
    maker,
    operator,
    byLine: (m: CatalogModel) => {
      const op = operator(m);
      return op
        ? t('modelWords.byLine', { maker: maker(m), operator: op })
        : t('modelWords.byMaker', { maker: maker(m) });
    },
    reason: (m: CatalogModel) =>
      usable(m)
        ? ''
        : m.reason === 'not_allowed'
          ? t('modelWords.reasonNotAllowed')
          : t('modelWords.reasonRequiresApproval'),
  };
};

export type ModelText = ReturnType<typeof useModelText>;
