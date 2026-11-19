import type { Route } from '../../hooks';
import { blockHref, type BlockKind, type CatalogItem } from '../../api/building-blocks';
import type { PlainKey } from '../../i18n';

export type TypeKey =
  | 'model'
  | 'search_engine'
  | 'tool'
  | 'skill'
  | 'guardrail'
  | 'judge'
  | 'extension_point'
  | 'step_type';

export type HomeKind = 'step_flow' | 'dataset' | 'shared_service';

export type Show = 'in-use' | 'catalogue';

export const typeKeys: readonly TypeKey[] = [
  'model',
  'search_engine',
  'tool',
  'skill',
  'guardrail',
  'judge',
  'extension_point',
  'step_type',
];

export const homeKinds: readonly HomeKind[] = ['step_flow', 'dataset', 'shared_service'];

export const typeNames: Record<TypeKey | HomeKind, PlainKey> = {
  model: 'blocks.kindManyModel',
  search_engine: 'blocks.kindManySearchEngine',
  tool: 'blocks.kindManyTool',
  skill: 'blocks.kindManySkill',
  guardrail: 'blocks.kindManyGuardrail',
  judge: 'blocks.kindManyJudge',
  extension_point: 'blocks.kindManyExtensionPoint',
  step_type: 'blockTypes.stepTypes',
  step_flow: 'blocks.kindManyStepFlow',
  dataset: 'blocks.kindManyDataset',
  shared_service: 'blocks.kindManySharedService',
};

export const typePurposes: Record<TypeKey | HomeKind, PlainKey> = {
  model: 'blockTypes.purposeModel',
  search_engine: 'blockTypes.purposeSearchEngine',
  tool: 'blockTypes.purposeTool',
  skill: 'blockTypes.purposeSkill',
  guardrail: 'blockTypes.purposeGuardrail',
  judge: 'blockTypes.purposeJudge',
  extension_point: 'blockTypes.purposeExtensionPoint',
  step_type: 'blockTypes.purposeStepType',
  step_flow: 'blockTypes.purposeStepFlow',
  dataset: 'blockTypes.purposeDataset',
  shared_service: 'blockTypes.purposeSharedService',
};

export const homeHrefs: Record<HomeKind, string> = {
  step_flow: '#/developer/step-flows',
  dataset: '#/datasets',
  shared_service: '#/shared-services',
};

export const homePlaces: Record<HomeKind, PlainKey> = {
  step_flow: 'blockTypes.placeStepFlows',
  dataset: 'blockTypes.placeDatasets',
  shared_service: 'blockTypes.placeSharedServices',
};

export const isStepType = (block: Pick<CatalogItem, 'kind' | 'id'>) =>
  block.kind === 'step_flow' && block.id.includes('@');

export const typeOf = (block: Pick<CatalogItem, 'kind' | 'id'>): TypeKey | HomeKind =>
  isStepType(block) ? 'step_type' : (block.kind as TypeKey | HomeKind);

const typeSegments: Partial<Record<TypeKey, string>> = { step_type: 'step-types' };

export const typeFromSegment = (segment: string | undefined): TypeKey | undefined =>
  typeKeys.find((key) => (typeSegments[key] ?? key) === segment);

export const typeHref = (key: TypeKey, show: Show = 'in-use', q = '') => {
  if (key === 'model')
    return show === 'catalogue' ? '#/building-blocks/models' : '#/building-blocks/models/in-use';
  const query = new URLSearchParams();
  if (show === 'catalogue') query.set('show', 'catalogue');
  if (q) query.set('q', q);
  const search = query.toString();
  return `#/building-blocks/${typeSegments[key] ?? key}${search ? `?${search}` : ''}`;
};

export const typeCardHref = (key: TypeKey) =>
  key === 'model' ? '#/building-blocks/models' : typeHref(key);

export const stepFlowHref = (id: string, rest = '') =>
  `#/developer/step-flows/${encodeURIComponent(id)}${rest}`;

export const itemHref = (block: Pick<CatalogItem, 'kind' | 'id'>) =>
  block.kind === 'step_flow' && !isStepType(block) ? stepFlowHref(block.id) : blockHref(block);

const isHomeKind = (kind: string): kind is HomeKind => homeKinds.some((k) => k === kind);

export const movedListHash = ({ segments, query }: Route) => {
  const show: Show = segments[1] === 'catalogue' ? 'catalogue' : 'in-use';
  const type = query.get('type') ?? '';
  const q = query.get('q') ?? '';
  if (isHomeKind(type)) return homeHrefs[type];
  const key = typeKeys.find((k) => k === type);
  if (key) return typeHref(key, show, q);
  return q ? `#/building-blocks?q=${encodeURIComponent(q)}` : '#/building-blocks';
};

export const movedKindHash = (kind: BlockKind, id: string | undefined, query: URLSearchParams) => {
  if (kind === 'step_flow' && id && !id.includes('@')) {
    const search = query.toString();
    return `${stepFlowHref(id)}${search ? `?${search}` : ''}`;
  }
  if (id) return undefined;
  if (isHomeKind(kind)) return homeHrefs[kind];
  if (kind === 'model') return '#/building-blocks/models';
  return undefined;
};
