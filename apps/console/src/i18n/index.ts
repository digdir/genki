import {
  defineCatalogue,
  type Format,
  type Locale,
  type MessageKey,
  type PlainKey as PlainKeyOf,
  type Translation,
} from '@genai/i18n';
import { defineTranslations } from '@genai/i18n/react';
import { api as enApi } from './en/api';
import { atlas as enAtlas } from './en/atlas';
import { audit as enAudit } from './en/audit';
import { blockReviews as enBlockReviews } from './en/blockReviews';
import { buildingBlocks as enBuildingBlocks } from './en/buildingBlocks';
import { catalog as enCatalog } from './en/catalog';
import { common as enCommon } from './en/common';
import { config as enConfig } from './en/config';
import { connections as enConnections } from './en/connections';
import { apis as enApis } from './en/apis';
import { diagnostics as enDiagnostics } from './en/diagnostics';
import { endpoints as enEndpoints } from './en/endpoints';
import { datasetSearch as enDatasetSearch } from './en/datasetSearch';
import { engineSwitch as enEngineSwitch } from './en/engineSwitch';
import { flags as enFlags } from './en/flags';
import { models as enModels } from './en/models';
import { modelOperations as enModelOperations } from './en/modelOperations';
import { modelParameters as enModelParameters } from './en/modelParameters';
import { onboarding as enOnboarding } from './en/onboarding';
import { operations as enOperations } from './en/operations';
import { platformSecrets as enPlatformSecrets } from './en/platformSecrets';
import { policies as enPolicies } from './en/policies';
import { quality as enQuality } from './en/quality';
import { qualityMatrix as enQualityMatrix } from './en/qualityMatrix';
import { queue as enQueue } from './en/queue';
import { quotaRequests as enQuotaRequests } from './en/quotaRequests';
import { schemas as enSchemas } from './en/schemas';
import { searchEngines as enSearchEngines } from './en/searchEngines';
import { settings as enSettings } from './en/settings';
import { sharedServices as enSharedServices } from './en/sharedServices';
import { stateRegister as enStateRegister } from './en/stateRegister';
import { demos as enDemos } from './en/demos';
import { shell as enShell } from './en/shell';
import { support as enSupport } from './en/support';
import { supportAccess as enSupportAccess } from './en/supportAccess';
import { tenantServices as enTenantServices } from './en/tenantServices';
import { tenants as enTenants } from './en/tenants';
import { tracing as enTracing } from './en/tracing';
import { transfer as enTransfer } from './en/transfer';
import { api } from './nb/api';
import { atlas } from './nb/atlas';
import { audit } from './nb/audit';
import { blockReviews } from './nb/blockReviews';
import { buildingBlocks } from './nb/buildingBlocks';
import { catalog } from './nb/catalog';
import { common } from './nb/common';
import { config } from './nb/config';
import { connections } from './nb/connections';
import { apis } from './nb/apis';
import { datasetSearch } from './nb/datasetSearch';
import { engineSwitch } from './nb/engineSwitch';
import { flags } from './nb/flags';
import { diagnostics } from './nb/diagnostics';
import { endpoints } from './nb/endpoints';
import { models } from './nb/models';
import { modelOperations } from './nb/modelOperations';
import { modelParameters } from './nb/modelParameters';
import { onboarding } from './nb/onboarding';
import { operations } from './nb/operations';
import { platformSecrets } from './nb/platformSecrets';
import { policies } from './nb/policies';
import { quality } from './nb/quality';
import { qualityMatrix } from './nb/qualityMatrix';
import { queue } from './nb/queue';
import { quotaRequests } from './nb/quotaRequests';
import { schemas } from './nb/schemas';
import { searchEngines } from './nb/searchEngines';
import { settings } from './nb/settings';
import { sharedServices } from './nb/sharedServices';
import { stateRegister } from './nb/stateRegister';
import { demos } from './nb/demos';
import { shell } from './nb/shell';
import { support } from './nb/support';
import { supportAccess } from './nb/supportAccess';
import { tenantServices } from './nb/tenantServices';
import { tenants } from './nb/tenants';
import { tracing } from './nb/tracing';
import { transfer } from './nb/transfer';

export const nb = defineCatalogue({
  api,
  atlas,
  audit,
  blockReviews,
  buildingBlocks,
  catalog,
  common,
  config,
  connections,
  datasetSearch,
  apis,
  diagnostics,
  endpoints,
  engineSwitch,
  flags,
  models,
  modelOperations,
  modelParameters,
  onboarding,
  operations,
  platformSecrets,
  policies,
  quality,
  qualityMatrix,
  queue,
  quotaRequests,
  schemas,
  searchEngines,
  settings,
  sharedServices,
  stateRegister,
  demos,
  shell,
  support,
  supportAccess,
  tenantServices,
  tenants,
  tracing,
  transfer,
});

export const en = {
  api: enApi,
  atlas: enAtlas,
  audit: enAudit,
  blockReviews: enBlockReviews,
  buildingBlocks: enBuildingBlocks,
  catalog: enCatalog,
  common: enCommon,
  config: enConfig,
  connections: enConnections,
  datasetSearch: enDatasetSearch,
  apis: enApis,
  diagnostics: enDiagnostics,
  endpoints: enEndpoints,
  engineSwitch: enEngineSwitch,
  flags: enFlags,
  models: enModels,
  modelOperations: enModelOperations,
  modelParameters: enModelParameters,
  onboarding: enOnboarding,
  operations: enOperations,
  platformSecrets: enPlatformSecrets,
  policies: enPolicies,
  quality: enQuality,
  qualityMatrix: enQualityMatrix,
  queue: enQueue,
  quotaRequests: enQuotaRequests,
  schemas: enSchemas,
  searchEngines: enSearchEngines,
  settings: enSettings,
  sharedServices: enSharedServices,
  stateRegister: enStateRegister,
  demos: enDemos,
  shell: enShell,
  support: enSupport,
  supportAccess: enSupportAccess,
  tenantServices: enTenantServices,
  tenants: enTenants,
  tracing: enTracing,
  transfer: enTransfer,
} satisfies Translation<typeof nb>;

export const { useT, translator } = defineTranslations({ nb, en });
export type Key = MessageKey<typeof nb>;
export type PlainKey = PlainKeyOf<typeof nb>;
export type T = ReturnType<typeof translator>;
export type { Format, Locale };
