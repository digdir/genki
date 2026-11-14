using '../main.bicep'

param environmentName = 'test'
param location = 'westeurope'
param postgresAdminGroupObjectId = readEnvironmentVariable('PG_ADMIN_GROUP_OBJECT_ID')
param postgresAdminGroupName = readEnvironmentVariable('PG_ADMIN_GROUP_NAME')
param deployPrincipalId = readEnvironmentVariable('DEPLOY_PRINCIPAL_ID', '')
param appIdentityIsPostgresAdmin = true
param minReplicas = 1
param maxReplicas = 2

// Test's own knowledge server (ADR 0042). Small to start (8 GiB, 64 GB): compute moves up or down with a short
// restart, the disk only grows. Geo-redundant backup is set only when the server is created.
// The workflows pass an unset variable as an empty value, which the default does not cover.
var knowledgeStage = readEnvironmentVariable('KNOWLEDGE_SERVER_STAGE', '')
param knowledgeServerStage = empty(knowledgeStage) ? 'none' : knowledgeStage
param knowledgePostgresSkuName = 'Standard_D2ds_v5'
param knowledgePostgresSkuTier = 'GeneralPurpose'
param knowledgePostgresStorageSizeGB = 64
param knowledgePostgresVCores = 2
param knowledgePostgresBackupRetentionDays = 7
param knowledgePostgresGeoRedundantBackup = 'Disabled'
param knowledgePostgresHighAvailability = 'Disabled'
param knowledgeAddressPrefix = '10.43.0.0/24'

param keyVaultSecretNames = [
  'content-master-key'
  'altinn-pdp-maskinporten-key'
  'altinn-subscription-key'
  'foundry-openai-key'
  'foundry-claude-key'
  'typesense-key'
  'colbert-api-key'
  'langfuse-public-key'
  'langfuse-secret-key'
]

param appEnv = {
  FOUNDRY_OPENAI_BASE_URL: readEnvironmentVariable('FOUNDRY_OPENAI_BASE_URL', '')
  FOUNDRY_CLAUDE_BASE_URL: readEnvironmentVariable('FOUNDRY_CLAUDE_BASE_URL', '')
  TYPESENSE_URL: readEnvironmentVariable('TYPESENSE_URL', '')
  COLBERT_API_URL: readEnvironmentVariable('COLBERT_API_URL', '')
  LANGFUSE_BASE_URL: 'https://langfuse.digdir.cloud'
  LANGFUSE_INSTANCE_RECEIVES_CONTENT: readEnvironmentVariable('LANGFUSE_INSTANCE_RECEIVES_CONTENT', 'false')
  TRACES_ENDPOINT: readEnvironmentVariable('TRACES_ENDPOINT', '')
  TRACES_ENVIRONMENT: 'test'
  TRACES_RESIDENCY: readEnvironmentVariable('TRACES_RESIDENCY', '')
  GENAI_LOCKDOWN: 'true'
  LOCKDOWN_ENTRA_GROUPS: readEnvironmentVariable('LOCKDOWN_ENTRA_GROUPS', '')
  LOCKDOWN_USER_GROUPS: readEnvironmentVariable('LOCKDOWN_USER_GROUPS', '')
  LOCKDOWN_ENTRA_EMAIL_DOMAIN: readEnvironmentVariable('LOCKDOWN_ENTRA_EMAIL_DOMAIN', 'digdir.no')
  OPERATOR_CLIENT_IDS: readEnvironmentVariable('OPERATOR_CLIENT_IDS', '')
}

param ansattportenIssuer = readEnvironmentVariable('ANSATTPORTEN_ISSUER', '')
param altinnResource = readEnvironmentVariable('ALTINN_RESOURCE', 'urn:altinn:resource:digdir-genai-platform')
param altinnPdpUrl = readEnvironmentVariable('ALTINN_PDP_URL', '')
param altinnPdpMaskinportenClientId = readEnvironmentVariable('ALTINN_PDP_MASKINPORTEN_CLIENT_ID', '')
param maskinportenIssuer = readEnvironmentVariable('MASKINPORTEN_ISSUER', '')
param maskinportenTokenUrl = readEnvironmentVariable('MASKINPORTEN_TOKEN_URL', '')
param operatorSubjects = readEnvironmentVariable('OPERATOR_SUBJECTS', '')
param platformTenant = readEnvironmentVariable('PLATFORM_TENANT', '')
param portalClientId = readEnvironmentVariable('PORTAL_CLIENT_ID', '')
param workspaceClientId = readEnvironmentVariable('WORKSPACE_CLIENT_ID', '')
param consoleClientId = readEnvironmentVariable('CONSOLE_CLIENT_ID', '')
param consoleTokenEndpoint = readEnvironmentVariable('CONSOLE_TOKEN_ENDPOINT', '')

param hostnames = {
  api: 'api.genki-test.digdir.cloud'
  portal: 'portal.genki-test.digdir.cloud'
  workspace: 'workspace.genki-test.digdir.cloud'
  console: 'console.genki-test.digdir.cloud'
}
param customDomainsStage = readEnvironmentVariable('CUSTOM_DOMAINS_STAGE', 'none')
param existingCertificates = {}
param createDnsZone = true
param dnsZoneName = 'genki-test.digdir.cloud'

param alertsEnabled = true
param alertEmails = readEnvironmentVariable('ALERT_EMAILS', '')
param healthCheckFrequencySeconds = 900
