using '../main.bicep'

param environmentName = 'test'
param location = 'norwayeast'
param postgresAdminGroupObjectId = readEnvironmentVariable('PG_ADMIN_GROUP_OBJECT_ID')
param postgresAdminGroupName = readEnvironmentVariable('PG_ADMIN_GROUP_NAME')
param deployPrincipalId = readEnvironmentVariable('DEPLOY_PRINCIPAL_ID', '')
param appIdentityIsPostgresAdmin = true
param minReplicas = 1
param maxReplicas = 2

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
  LOCKDOWN_ENTRA_EMAIL_DOMAIN: readEnvironmentVariable('LOCKDOWN_ENTRA_EMAIL_DOMAIN', 'digdir.no')
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
param existingCertificates = {
  api: 'api.genki-test.digdir.cloud-rg-genai-261013140406'
  portal: 'portal.genki-test.digdir.clo-rg-genai-261013140322'
  workspace: 'workspace.genki-test.digdir-rg-genai-261013140358'
  console: 'console.genki-test.digdir.cl-rg-genai-261013140345'
}
param createDnsZone = true
param dnsZoneName = 'genki-test.digdir.cloud'
