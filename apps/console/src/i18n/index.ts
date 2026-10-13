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
import { audit as enAudit } from './en/audit';
import { buildingBlocks as enBuildingBlocks } from './en/buildingBlocks';
import { catalog as enCatalog } from './en/catalog';
import { common as enCommon } from './en/common';
import { config as enConfig } from './en/config';
import { diagnostics as enDiagnostics } from './en/diagnostics';
import { endpoints as enEndpoints } from './en/endpoints';
import { models as enModels } from './en/models';
import { modelParameters as enModelParameters } from './en/modelParameters';
import { onboarding as enOnboarding } from './en/onboarding';
import { operations as enOperations } from './en/operations';
import { policies as enPolicies } from './en/policies';
import { quality as enQuality } from './en/quality';
import { qualityMatrix as enQualityMatrix } from './en/qualityMatrix';
import { queue as enQueue } from './en/queue';
import { schemas as enSchemas } from './en/schemas';
import { searchEngines as enSearchEngines } from './en/searchEngines';
import { settings as enSettings } from './en/settings';
import { sharedServices as enSharedServices } from './en/sharedServices';
import { shell as enShell } from './en/shell';
import { support as enSupport } from './en/support';
import { supportAccess as enSupportAccess } from './en/supportAccess';
import { tenantServices as enTenantServices } from './en/tenantServices';
import { tenants as enTenants } from './en/tenants';
import { tracing as enTracing } from './en/tracing';
import { transfer as enTransfer } from './en/transfer';
import { api } from './nb/api';
import { audit } from './nb/audit';
import { buildingBlocks } from './nb/buildingBlocks';
import { catalog } from './nb/catalog';
import { common } from './nb/common';
import { config } from './nb/config';
import { diagnostics } from './nb/diagnostics';
import { endpoints } from './nb/endpoints';
import { models } from './nb/models';
import { modelParameters } from './nb/modelParameters';
import { onboarding } from './nb/onboarding';
import { operations } from './nb/operations';
import { policies } from './nb/policies';
import { quality } from './nb/quality';
import { qualityMatrix } from './nb/qualityMatrix';
import { queue } from './nb/queue';
import { schemas } from './nb/schemas';
import { searchEngines } from './nb/searchEngines';
import { settings } from './nb/settings';
import { sharedServices } from './nb/sharedServices';
import { shell } from './nb/shell';
import { support } from './nb/support';
import { supportAccess } from './nb/supportAccess';
import { tenantServices } from './nb/tenantServices';
import { tenants } from './nb/tenants';
import { tracing } from './nb/tracing';
import { transfer } from './nb/transfer';

export const nb = defineCatalogue({
  api,
  audit,
  buildingBlocks,
  catalog,
  common,
  config,
  diagnostics,
  endpoints,
  models,
  modelParameters,
  onboarding,
  operations,
  policies,
  quality,
  qualityMatrix,
  queue,
  schemas,
  searchEngines,
  settings,
  sharedServices,
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
  audit: enAudit,
  buildingBlocks: enBuildingBlocks,
  catalog: enCatalog,
  common: enCommon,
  config: enConfig,
  diagnostics: enDiagnostics,
  endpoints: enEndpoints,
  models: enModels,
  modelParameters: enModelParameters,
  onboarding: enOnboarding,
  operations: enOperations,
  policies: enPolicies,
  quality: enQuality,
  qualityMatrix: enQualityMatrix,
  queue: enQueue,
  schemas: enSchemas,
  searchEngines: enSearchEngines,
  settings: enSettings,
  sharedServices: enSharedServices,
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
