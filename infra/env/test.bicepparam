using '../main.bicep'

param environmentName = 'test'
param location = 'westeurope'
param postgresAdminGroupObjectId = readEnvironmentVariable('PG_ADMIN_GROUP_OBJECT_ID')
param postgresAdminGroupName = readEnvironmentVariable('PG_ADMIN_GROUP_NAME')
param deployPrincipalId = readEnvironmentVariable('DEPLOY_PRINCIPAL_ID', '')
param appIdentityIsPostgresAdmin = true
param minReplicas = 1
param maxReplicas = 2

// Prod creates the one knowledge server for test and prod; test has its own database on it.
// The workflows pass an unset variable as an empty value, which the default does not cover.
var knowledgeStage = readEnvironmentVariable('KNOWLEDGE_SERVER_STAGE', '')
param knowledgeServerStage = empty(knowledgeStage) ? 'none' : knowledgeStage
param knowledgePostgresHost = readEnvironmentVariable('KNOWLEDGE_PGHOST', '')
param knowledgeDatabaseName = 'genai_knowledge_test'
// Both from prod's outputs knowledgePostgresHost and knowledgePostgresVCores.
var knowledgeVCores = readEnvironmentVariable('KNOWLEDGE_VCORES', '')
param knowledgePostgresVCores = int(empty(knowledgeVCores) ? '2' : knowledgeVCores)

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
