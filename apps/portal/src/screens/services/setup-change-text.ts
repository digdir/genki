import type { PlainKey, T } from '../../i18n';
import type { ChangeArea, DraftChange } from './setup-diff';

export const areaLabelKeys: Record<ChangeArea, PlainKey> = {
  purpose: 'setupList.areaPurpose',
  sources: 'setupList.areaSources',
  input: 'setupList.areaInput',
  result: 'setupList.areaResult',
  model: 'setupList.areaModel',
  tools: 'setupList.areaTools',
  how: 'setupList.areaHow',
  variants: 'setupList.areaVariants',
  guards: 'setupList.areaGuards',
  risk: 'setupList.areaRisk',
  limits: 'setupList.areaLimits',
  channels: 'setupList.areaChannels',
  quality: 'setupList.areaQuality',
  other: 'setupList.areaOther',
};

const guardKeys: Record<string, PlainKey> = {
  'pii-before-model': 'setup.piiBefore',
  'pii-out-of-log': 'setup.piiLog',
  'require-sources': 'setup.requireSources',
  'refuse-topics': 'setup.refuseTopics',
  'human-approval': 'setup.humanApproval',
};

const riskKeys: Record<string, PlainKey> = {
  minimal: 'setup.riskMinimal',
  limited: 'setup.riskLimited',
  high: 'setup.riskHigh',
};

export interface ChangeNames {
  dataset: (ref: string) => string;
  model: (id: string) => string;
  tool: (ref: string) => string;
}

export const guardName = (t: T, key: string) => {
  const found = guardKeys[key];
  return found ? t(found) : key;
};

const byKind = <K extends string>(
  kind: DraftChange['kind'],
  keys: Record<DraftChange['kind'], K>,
) => keys[kind];

export const changeLabel = (t: T, c: DraftChange) =>
  c.topic === 'instructions' || c.topic === 'examples' || c.topic === 'languages'
    ? t('setupList.areaInstructions')
    : t(areaLabelKeys[c.area]);

export const changeText = (t: T, c: DraftChange, names: ChangeNames): string => {
  const subject = c.subject ?? '';
  switch (c.topic) {
    case 'name':
      return t('serviceDraft.changeName', { after: c.after ?? '' });
    case 'purpose':
      return t('serviceDraft.changePurpose');
    case 'audience':
      return t('serviceDraft.changeAudience');
    case 'instructions':
      return t(
        c.kind === 'added'
          ? 'serviceDraft.changeInstructionsAdded'
          : 'serviceDraft.changeInstructions',
      );
    case 'examples':
      return t('serviceDraft.changeExamples');
    case 'languages':
      return t('serviceDraft.changeLanguages');
    case 'riskClass':
      return c.after
        ? t('serviceDraft.changeRiskClass', {
            after: riskKeys[c.after] ? t(riskKeys[c.after] as PlainKey) : c.after,
          })
        : t('serviceDraft.changeRiskClassRemoved');
    case 'riskConfirmation':
      return t(
        byKind(c.kind, {
          added: 'serviceDraft.changeRiskConfirmed',
          removed: 'serviceDraft.changeRiskConfirmationRemoved',
          changed: 'serviceDraft.changeRiskConfirmationChanged',
        }),
      );
    case 'dataset':
      return t(
        byKind(c.kind, {
          added: 'serviceDraft.changeDatasetAdded',
          removed: 'serviceDraft.changeDatasetRemoved',
          changed: 'serviceDraft.changeDatasetChanged',
        }),
        { name: names.dataset(subject) },
      );
    case 'knowledge':
      return t('serviceDraft.changeKnowledge');
    case 'inputField':
      return t(
        byKind(c.kind, {
          added: 'serviceDraft.changeInputFieldAdded',
          removed: 'serviceDraft.changeInputFieldRemoved',
          changed: 'serviceDraft.changeInputFieldChanged',
        }),
        { name: subject },
      );
    case 'files':
      return t(c.kind === 'removed' ? 'serviceDraft.changeFilesOff' : 'serviceDraft.changeFilesOn');
    case 'input':
      return t('serviceDraft.changeInput');
    case 'output':
      return t('serviceDraft.changeOutput');
    case 'model':
      return t('serviceDraft.changeModel', {
        before: names.model(c.before ?? ''),
        after: names.model(c.after ?? ''),
      });
    case 'fallback':
      return t(
        byKind(c.kind, {
          added: 'serviceDraft.changeFallbackAdded',
          removed: 'serviceDraft.changeFallbackRemoved',
          changed: 'serviceDraft.changeFallbackChanged',
        }),
        { before: names.model(c.before ?? ''), after: names.model(c.after ?? '') },
      );
    case 'operations':
      return t('serviceDraft.changeOperations');
    case 'tool':
      return subject
        ? t(
            byKind(c.kind, {
              added: 'serviceDraft.changeToolAdded',
              removed: 'serviceDraft.changeToolRemoved',
              changed: 'serviceDraft.changeToolChanged',
            }),
            { name: names.tool(subject) },
          )
        : t('serviceDraft.changeToolChanged');
    case 'strategy':
      return t('serviceDraft.changeStrategy');
    case 'improve':
      return t('serviceDraft.changeImprove');
    case 'variants':
      return t('serviceDraft.changeVariants');
    case 'guard':
      return t(
        byKind(c.kind, {
          added: 'serviceDraft.changeGuardAdded',
          removed: 'serviceDraft.changeGuardRemoved',
          changed: 'serviceDraft.changeGuardChanged',
        }),
        { name: guardName(t, subject) },
      );
    case 'settings':
      return t('serviceDraft.changeSettings');
    case 'channels':
      return t('serviceDraft.changeChannels');
    case 'quality':
      return t('serviceDraft.changeQuality');
    default:
      return c.area === 'model' && !subject
        ? t('serviceDraft.changeModelOther')
        : t('serviceDraft.changeOther', { key: subject });
  }
};
