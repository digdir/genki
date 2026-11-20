using '../main.bicep'

param environmentName = 'test'
param location = 'westeurope'
param postgresAdminGroupObjectId = readEnvironmentVariable('PG_ADMIN_GROUP_OBJECT_ID')
param postgresAdminGroupName = readEnvironmentVariable('PG_ADMIN_GROUP_NAME')
param deployPrincipalId = readEnvironmentVariable('DEPLOY_PRINCIPAL_ID', '')
param appIdentityIsPostgresAdmin = true
param postgresSkuName = 'Standard_B2s'
param postgresSkuTier = 'Burstable'
param postgresBackupRetentionDays = 35
param postgresMaintenanceWindow = { customWindow: 'Enabled', dayOfWeek: 0, startHour: 2, startMinute: 0 }
param backupsEnabled = true
param endpointsSubnetPrefix = '10.40.3.0/27'
// Off until someone with Owner or User Access Administrator turns them on (infra/README.md, "Backups").
param resourceLocksEnabled = false
param minReplicas = 1
param maxReplicas = 2
param workerRevisionsMode = 'Multiple'

// Test's own knowledge server (ADR 0042). Small to start (8 GiB, 64 GB): compute moves up or down with a short
// restart, the disk only grows. Autogrow took the disk to 128 GB in November 2026, and the template follows it,
// since Azure refuses a smaller size. Geo-redundant backup is set only when the server is created.
// The workflows pass an unset variable as an empty value, which the default does not cover.
var knowledgeStage = readEnvironmentVariable('KNOWLEDGE_SERVER_STAGE', '')
param knowledgeServerStage = empty(knowledgeStage) ? 'none' : knowledgeStage
param knowledgePostgresSkuName = 'Standard_D2ds_v5'
param knowledgePostgresSkuTier = 'GeneralPurpose'
param knowledgePostgresStorageSizeGB = 128
// Raised to P30 by hand when the Kudos fill ran out of disk burst on 2026-11-14 (issue 599), and set here so infra
// leaves it there. The tier test steps down to waits for a week of Kudos searches; see infra/README.md, "Disk tier".
param knowledgePostgresPerformanceTier = 'P30'
param knowledgePostgresVCores = 2
param knowledgePostgresBackupRetentionDays = 7
param knowledgePostgresGeoRedundantBackup = 'Disabled'
param knowledgePostgresHighAvailability = 'Disabled'
param knowledgeAddressPrefix = '10.43.0.0/24'

// The people source's secrets join only once its variables are set, so a deploy never names a secret not yet in Key Vault.
var altinnPeople = readEnvironmentVariable('ALTINN_PEOPLE_URL', '')
var altinnPeopleClient = readEnvironmentVariable('ALTINN_PEOPLE_MASKINPORTEN_CLIENT_ID', '')

param keyVaultSecretNames = concat(
  [
    'content-master-key'
    'altinn-pdp-maskinporten-key'
    'altinn-subscription-key'
    'foundry-openai-key'
    'foundry-claude-key'
    'typesense-key'
    'colbert-api-key'
    'langfuse-public-key'
    'langfuse-secret-key'
  ],
  empty(altinnPeople) ? [] : ['access-person-key-secret'],
  empty(altinnPeople) || empty(altinnPeopleClient) ? [] : ['altinn-people-maskinporten-key']
)

// An unset variable comes as an empty value here too.
var langfuseContent = readEnvironmentVariable('LANGFUSE_INSTANCE_RECEIVES_CONTENT', '')

param appEnv = {
  FOUNDRY_OPENAI_BASE_URL: readEnvironmentVariable('FOUNDRY_OPENAI_BASE_URL', '')
  FOUNDRY_CLAUDE_BASE_URL: readEnvironmentVariable('FOUNDRY_CLAUDE_BASE_URL', '')
  TYPESENSE_URL: readEnvironmentVariable('TYPESENSE_URL', '')
  COLBERT_API_URL: readEnvironmentVariable('COLBERT_API_URL', '')
  LANGFUSE_BASE_URL: 'https://langfuse.digdir.cloud'
  // True unless the variable is set: operators confirmed ADR 0011's conditions.
  LANGFUSE_INSTANCE_RECEIVES_CONTENT: empty(langfuseContent) ? 'true' : langfuseContent
  TRACES_ENDPOINT: readEnvironmentVariable('TRACES_ENDPOINT', '')
  TRACES_ENVIRONMENT: 'test'
  TRACES_RESIDENCY: readEnvironmentVariable('TRACES_RESIDENCY', '')
  GENAI_LOCKDOWN: 'true'
  LOCKDOWN_ENTRA_GROUPS: readEnvironmentVariable('LOCKDOWN_ENTRA_GROUPS', '')
  LOCKDOWN_USER_GROUPS: readEnvironmentVariable('LOCKDOWN_USER_GROUPS', '')
  LOCKDOWN_SERVICE_GROUPS: readEnvironmentVariable('LOCKDOWN_SERVICE_GROUPS', '')
  LOCKDOWN_SERVICE_CLIENT_IDS: readEnvironmentVariable('LOCKDOWN_SERVICE_CLIENT_IDS', '')
  LOCKDOWN_ENTRA_EMAIL_DOMAIN: readEnvironmentVariable('LOCKDOWN_ENTRA_EMAIL_DOMAIN', 'digdir.no')
  OPERATOR_CLIENT_IDS: readEnvironmentVariable('OPERATOR_CLIENT_IDS', '')
  GATEWAY_USAGE_URL: 'https://api.aivar.no'
  GATEWAY_USAGE_APP_CLIENT_ID: '334f8fa1-437e-4b84-bceb-f320fb60f3ed'
  GATEWAY_USAGE_APP_TENANT: '008e560f-08af-4cec-a056-b35447503991'
  GATEWAY_USAGE_APP_SCOPE: 'api://3eca282e-8b4d-49d6-991f-79849dffd652/.default'
}

param ansattportenIssuer = readEnvironmentVariable('ANSATTPORTEN_ISSUER', '')
param altinnResource = readEnvironmentVariable('ALTINN_RESOURCE', 'urn:altinn:resource:digdir-genai-platform')
param altinnPdpUrl = readEnvironmentVariable('ALTINN_PDP_URL', '')
param altinnPdpMaskinportenClientId = readEnvironmentVariable('ALTINN_PDP_MASKINPORTEN_CLIENT_ID', '')
param maskinportenIssuer = readEnvironmentVariable('MASKINPORTEN_ISSUER', '')
param maskinportenTokenUrl = readEnvironmentVariable('MASKINPORTEN_TOKEN_URL', '')
param altinnPeopleUrl = altinnPeople
param altinnPeopleMaskinportenClientId = altinnPeopleClient
param altinnPeopleMaskinportenScope = readEnvironmentVariable('ALTINN_PEOPLE_MASKINPORTEN_SCOPE', '')
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
  assistant: 'assistant.genki-test.digdir.cloud'
}
param customDomainsStage = readEnvironmentVariable('CUSTOM_DOMAINS_STAGE', 'none')
param existingCertificates = {}
param createDnsZone = true
param dnsZoneName = 'genki-test.digdir.cloud'
// Each hostname moves none, hostnames, certificates, one deploy at a time (infra/README.md, "Hosted hostnames").
param assistantHostEnabled = true
param assistantBffEnabled = true
param assistantHostnameStage = 'none'
param hostedHostnames = [
  { subdomain: 'kunnskap', tenant: '312521172', stage: 'none' }
]
// genki's platform login client for hosted Clients without oidc (infra/README.md, "Platform login").
param platformLoginClientId = 'dde98722-c952-4172-a5d6-10bdf721680f'
param platformLoginStage = 'none'

param alertsEnabled = true
param alertEmails = readEnvironmentVariable('ALERT_EMAILS', '')
param healthCheckFrequencySeconds = 300
// Off until the deploy identity may write a rule scoped to the subscription (infra/README.md, "Backups").
param serviceHealthAlertEnabled = false
param infraBudgetAmount = 5000
param modelsBudgetAmount = 8000
// Empty until the deploy identity has Cost Management Contributor on rg-genki-test-swc (infra/README.md, "Backups").
param modelsBudgetResourceGroup = ''
