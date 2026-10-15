using '../main.bicep'

param environmentName = 'prod'
param location = 'norwayeast'
param postgresAdminGroupObjectId = readEnvironmentVariable('PG_ADMIN_GROUP_OBJECT_ID')
param postgresAdminGroupName = readEnvironmentVariable('PG_ADMIN_GROUP_NAME')
param deployPrincipalId = readEnvironmentVariable('DEPLOY_PRINCIPAL_ID', '')
param appIdentityIsPostgresAdmin = true
param postgresSkuName = 'Standard_D2ds_v5'
param postgresSkuTier = 'GeneralPurpose'
param postgresStorageSizeGB = 64
param postgresBackupRetentionDays = 30
param postgresGeoRedundantBackup = 'Enabled'
param postgresHighAvailability = 'Disabled'
param minReplicas = 1
param maxReplicas = 3
param keyVaultPublicNetworkAccess = 'Enabled'

param addressPrefix = '10.41.0.0/16'
param appsSubnetPrefix = '10.41.0.0/23'
param postgresSubnetPrefix = '10.41.2.0/24'

param keyVaultSecretNames = [
  'content-master-key'
  'altinn-pdp-maskinporten-key'
  'altinn-subscription-key'
  'foundry-openai-key'
  'foundry-claude-key'
  'typesense-key'
  'colbert-api-key'
]

param appEnv = {
  FOUNDRY_OPENAI_BASE_URL: readEnvironmentVariable('FOUNDRY_OPENAI_BASE_URL', '')
  FOUNDRY_CLAUDE_BASE_URL: readEnvironmentVariable('FOUNDRY_CLAUDE_BASE_URL', '')
  TYPESENSE_URL: readEnvironmentVariable('TYPESENSE_URL', '')
  COLBERT_API_URL: readEnvironmentVariable('COLBERT_API_URL', '')
}

param ansattportenIssuer = readEnvironmentVariable('ANSATTPORTEN_ISSUER', '')
param altinnResource = 'urn:altinn:resource:digdir-genai-platform'
param altinnPdpUrl = readEnvironmentVariable('ALTINN_PDP_URL', '')
param altinnPdpMaskinportenClientId = readEnvironmentVariable('ALTINN_PDP_MASKINPORTEN_CLIENT_ID', '')
param maskinportenIssuer = readEnvironmentVariable('MASKINPORTEN_ISSUER', '')
param maskinportenTokenUrl = readEnvironmentVariable('MASKINPORTEN_TOKEN_URL', '')
param operatorSubjects = readEnvironmentVariable('OPERATOR_SUBJECTS', '')
param platformTenant = ''
param portalClientId = readEnvironmentVariable('PORTAL_CLIENT_ID', '')
param workspaceClientId = readEnvironmentVariable('WORKSPACE_CLIENT_ID', '')
param consoleClientId = readEnvironmentVariable('CONSOLE_CLIENT_ID', '')
param consoleTokenEndpoint = readEnvironmentVariable('CONSOLE_TOKEN_ENDPOINT', '')

param hostnames = {
  api: 'api.genki.digdir.cloud'
  portal: 'portal.genki.digdir.cloud'
  workspace: 'workspace.genki.digdir.cloud'
  console: 'console.genki.digdir.cloud'
}
param customDomainsStage = readEnvironmentVariable('CUSTOM_DOMAINS_STAGE', 'none')
param createDnsZone = true
param dnsZoneName = 'genki.digdir.cloud'
