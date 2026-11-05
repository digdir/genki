import type { ApiClient } from '../../api';
import type {
  ApiBindings,
  ConfigEntry,
  DiscoveryRule,
  EndpointProcessorRecord,
  Maturity,
  ModelApi,
  OperationDescriptor,
  OperationKind,
  OperationKinds,
  OperatorModel,
} from '../../types';

export interface AreaData {
  models: OperatorModel[];
  connections: ConfigEntry[] | undefined;
  apis: ModelApi[] | undefined;
  kinds: OperationKinds | undefined;
  descriptors: OperationDescriptor[] | undefined;
  records: EndpointProcessorRecord[] | undefined;
}

export interface AreaProps {
  api: ApiClient;
  data: AreaData;
  done: (message: string) => void;
}

export const modelsHref = (params: Record<string, string> = {}) => {
  const query = new URLSearchParams(params).toString();
  return query ? `#/models?${query}` : '#/models';
};

export type ModelsTab = 'connections' | 'models' | 'apis';

export const tabOf = (value: string | null | undefined): ModelsTab =>
  value === 'models' || value === 'apis' ? value : 'connections';

export interface ConnectionSpec {
  baseURL?: string;
  families: Record<string, string>;
  discovery: DiscoveryRule[];
  authKind?: string;
  secret?: string;
}

const secretPrefix = 'secret://platform/';

export const connectionSpec = (entry: ConfigEntry): ConnectionSpec => {
  const spec = entry.spec as {
    baseURL?: string;
    families?: Record<string, string>;
    discovery?: DiscoveryRule[];
    auth?: { kind?: string; secret?: string };
  };
  return {
    ...(spec.baseURL ? { baseURL: spec.baseURL } : {}),
    families: spec.families && typeof spec.families === 'object' ? spec.families : {},
    discovery: Array.isArray(spec.discovery) ? spec.discovery : [],
    ...(spec.auth?.kind ? { authKind: spec.auth.kind } : {}),
    ...(spec.auth?.secret ? { secret: spec.auth.secret.replace(secretPrefix, '') } : {}),
  };
};

export const familiesOf = (entry: ConfigEntry | undefined) =>
  entry ? Object.keys(connectionSpec(entry).families) : undefined;

export type RecordStatus = 'recorded' | 'missing' | 'unknown';

export const recordStatus = (
  records: EndpointProcessorRecord[] | undefined,
  connection: string,
): RecordStatus => {
  if (!records) return 'unknown';
  return records.find((r) => r.endpoint === connection)?.record ? 'recorded' : 'missing';
};

/** The models on a connection that are switched on; a connection with any cannot be removed. */
export const modelsInUse = (connection: string, models: OperatorModel[]) =>
  models.filter((m) => m.endpoint === connection && m.enabled);

/** The APIs a model on this connection may bind for a kind: those in a family the connection offers. */
export const apisFor = (apis: ModelApi[], families: string[] | undefined, kind: string) =>
  apis.filter((a) => a.kind === kind && (!families || families.includes(a.family)));

export const boundOf = (model: Pick<OperatorModel, 'apis'>): ApiBindings => model.apis ?? {};

export type ApiOrigin = 'built-in' | 'built-in-described' | 'bundled' | 'uploaded';

export const originOf = (
  api: Pick<ModelApi, 'id' | 'source'>,
  descriptors: OperationDescriptor[] | undefined,
): ApiOrigin => {
  if (api.source !== 'built-in') return api.source;
  return descriptors?.some((d) => d.id === api.id) ? 'built-in-described' : 'built-in';
};

export const kindMaturity = (
  kinds: OperationKind[] | undefined,
  kind: string,
): Maturity | 'built-in' | undefined => {
  const found = kinds?.find((k) => k.kind === kind);
  if (!found) return undefined;
  return found.builtIn ? 'built-in' : found.maturity;
};

export interface ModelFilter {
  text: string;
  connection: string;
  kind: string;
  confirmed: 'all' | 'confirmed' | 'unconfirmed';
}

export const allModels: ModelFilter = { text: '', connection: '', kind: '', confirmed: 'all' };

const unconfirmed = (m: OperatorModel) => m.origin === 'discovered' && !m.classified;

export const filterModels = (models: OperatorModel[], filter: ModelFilter) => {
  const text = filter.text.trim().toLowerCase();
  return models.filter(
    (m) =>
      (!text || [m.id, m.deployment, m.family ?? ''].some((v) => v.toLowerCase().includes(text))) &&
      (!filter.connection || m.endpoint === filter.connection) &&
      (!filter.kind || Boolean(boundOf(m)[filter.kind])) &&
      (filter.confirmed === 'all' || (filter.confirmed === 'unconfirmed') === unconfirmed(m)),
  );
};

export const isUnconfirmed = unconfirmed;

export type GuideStep = 'upload' | 'try' | 'record' | 'approve' | 'bind' | 'production';

export const guideSteps: GuideStep[] = ['upload', 'try', 'record', 'approve', 'bind', 'production'];

export const stepOf = (value: string | null | undefined): GuideStep | undefined =>
  guideSteps.find((s) => s === value);

export interface GuideState {
  api: ModelApi;
  descriptor: OperationDescriptor | undefined;
  kind: OperationKind | undefined;
  models: OperatorModel[];
  connections: ConfigEntry[];
  records: EndpointProcessorRecord[] | undefined;
}

const passing = (d: OperationDescriptor | undefined) =>
  Boolean(d && d.fixtures > 0 && d.contract?.passed);

const approved = (api: ModelApi) => api.status !== 'review';

export const boundModels = (state: Pick<GuideState, 'api' | 'models'>) =>
  state.models.filter((m) => boundOf(m)[state.api.kind] === state.api.id);

export const inProduction = (state: Pick<GuideState, 'kind'>) =>
  !state.kind || state.kind.builtIn || state.kind.maturity === 'production';

export const stepsDone = (state: GuideState): Record<GuideStep, boolean> => ({
  upload: true,
  try: passing(state.descriptor) || state.api.source === 'built-in',
  record: passing(state.descriptor) || state.api.source === 'built-in',
  approve: approved(state.api),
  bind: boundModels(state).length > 0,
  production: inProduction(state),
});

export const firstOpenStep = (state: GuideState): GuideStep =>
  guideSteps.find((s) => !stepsDone(state)[s]) ?? 'production';

/** The connections whose models could serve the API: they offer its family. */
export const connectionsFor = (state: Pick<GuideState, 'api' | 'connections'>) =>
  state.connections.filter((c) => familiesOf(c)?.includes(state.api.family));

export type Missing =
  | { item: 'approval' }
  | { item: 'testCase' }
  | { item: 'noModel' }
  | { item: 'kindInTest'; kind: string }
  | { item: 'processorRecord'; connection: string }
  | { item: 'noFamily'; family: string };

export type Ready =
  | { item: 'processorRecord'; connection: string }
  | { item: 'family'; family: string; connection: string };

/** What still stands between the API and real data, and what is already in place. */
export const beforeProduction = (state: GuideState): { missing: Missing[]; ready: Ready[] } => {
  const missing: Missing[] = [];
  const ready: Ready[] = [];
  if (!approved(state.api)) missing.push({ item: 'approval' });
  if (state.api.source !== 'built-in' && !passing(state.descriptor))
    missing.push({ item: 'testCase' });
  const bound = boundModels(state);
  if (bound.length === 0) missing.push({ item: 'noModel' });
  if (!inProduction(state)) missing.push({ item: 'kindInTest', kind: state.api.kind });
  const offering = connectionsFor(state);
  if (offering.length === 0) missing.push({ item: 'noFamily', family: state.api.family });
  const concerned =
    bound.length > 0 ? offering.filter((c) => bound.some((m) => m.endpoint === c.id)) : offering;
  for (const c of concerned) {
    if (recordStatus(state.records, c.id) === 'missing')
      missing.push({ item: 'processorRecord', connection: c.id });
    else if (recordStatus(state.records, c.id) === 'recorded')
      ready.push({ item: 'processorRecord', connection: c.id });
    ready.push({ item: 'family', family: state.api.family, connection: c.id });
  }
  return { missing, ready };
};
