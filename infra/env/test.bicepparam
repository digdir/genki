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

// Test's own knowledge server (ADR 0042). Started at 8 GiB and 64 GB; moved to 32 GiB in November 2026 to keep the
// Kudos vector index (13.6 GB) in memory. Compute moves up or down with a short restart, the disk only grows.
// Autogrow took the disk to 128 GB in November 2026, and the template follows it, since Azure refuses a smaller size. Geo-redundant backup is set only when the server is created.
// The workflows pass an unset variable as an empty value, which the default does not cover.
var knowledgeStage = readEnvironmentVariable('KNOWLEDGE_SERVER_STAGE', '')
param knowledgeServerStage = empty(knowledgeStage) ? 'none' : knowledgeStage
param knowledgePostgresSkuName = 'Standard_E4ds_v5'
param knowledgePostgresSkuTier = 'MemoryOptimized'
param knowledgePostgresStorageSizeGB = 128
// Raised to P30 by hand when the Kudos fill ran out of disk burst on 2026-11-14 (issue 599), and set here so infra
// leaves it there. The tier test steps down to waits for a week of Kudos searches; see infra/README.md, "Disk tier".
param knowledgePostgresPerformanceTier = 'P30'
param knowledgePostgresVCores = 4
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
    'langfuse-public-key'
    'langfuse-secret-key'
  ],
  empty(altinnPeople) ? [] : ['access-person-key-secret'],
  empty(altinnPeople) || empty(altinnPeopleClient) ? [] : ['altinn-people-maskinporten-key']
)

var emailDomain = readEnvironmentVariable('ENTRA_EMAIL_DOMAIN', '')

// An unset variable comes as an empty value here too.
var langfuseContent = readEnvironmentVariable('LANGFUSE_INSTANCE_RECEIVES_CONTENT', '')

param appEnv = {
  FOUNDRY_OPENAI_BASE_URL: readEnvironmentVariable('FOUNDRY_OPENAI_BASE_URL', '')
  FOUNDRY_CLAUDE_BASE_URL: readEnvironmentVariable('FOUNDRY_CLAUDE_BASE_URL', '')
  LANGFUSE_BASE_URL: 'https://langfuse.digdir.cloud'
  // True unless the variable is set: operators confirmed ADR 0011's conditions.
  LANGFUSE_INSTANCE_RECEIVES_CONTENT: empty(langfuseContent) ? 'true' : langfuseContent
  TRACES_ENDPOINT: readEnvironmentVariable('TRACES_ENDPOINT', '')
  TRACES_RESIDENCY: readEnvironmentVariable('TRACES_RESIDENCY', '')
  OPERATOR_ENTRA_GROUPS: readEnvironmentVariable('OPERATOR_ENTRA_GROUPS', '')
  MEMBER_ENTRA_GROUPS: readEnvironmentVariable('MEMBER_ENTRA_GROUPS', '')
  SERVICE_ENTRA_GROUPS: readEnvironmentVariable('SERVICE_ENTRA_GROUPS', '')
  SERVICE_ENTRA_CLIENT_IDS: readEnvironmentVariable('SERVICE_ENTRA_CLIENT_IDS', '')
  ENTRA_EMAIL_DOMAIN: empty(emailDomain) ? 'digdir.no' : emailDomain
  OPERATOR_CLIENT_IDS: readEnvironmentVariable('OPERATOR_CLIENT_IDS', '')
  GATEWAY_USAGE_URL: 'https://api.aivar.no'
  GATEWAY_USAGE_APP_CLIENT_ID: '334f8fa1-437e-4b84-bceb-f320fb60f3ed'
  GATEWAY_USAGE_APP_TENANT: '008e560f-08af-4cec-a056-b35447503991'
  GATEWAY_USAGE_APP_SCOPE: 'api://3eca282e-8b4d-49d6-991f-79849dffd652/.default'
  // The sites whose cited PDFs the API serves in Dokumentvisning (ADR 0066, infra/README.md).
  GENAI_DOCUMENT_FILE_ORIGINS: 'https://kudos.dfo.no'
  // The demo-recorder workflow records what the console queues (ADR 0059).
  GENAI_DEMO_RECORDER: 'scheduled'
  DEMO_RECORDER_KEY_SHA256: readEnvironmentVariable('DEMO_RECORDER_KEY_SHA256', '')
}

// What issue 464 turns when genki-test becomes production; the resource names stay genai-test-*.
param platformTier = 'test'
param lockdown = !productionLogin
param tracesEnvironment = 'test'
param testRunnerKeys = true

// Production Ansattporten turns on its own client and turns lockdown off (docs/runbook.md, "Production Ansattporten").
var issuer = readEnvironmentVariable('ANSATTPORTEN_ISSUER', '')
var productionLogin = issuer == 'https://ansattporten.no'
var altinnPdp = readEnvironmentVariable('ALTINN_PDP_URL', '')
param ansattportenIssuer = !empty(issuer) && !contains(['https://test.ansattporten.no', 'https://ansattporten.no'], issuer)
  ? fail('ANSATTPORTEN_ISSUER must be https://test.ansattporten.no or https://ansattporten.no')
  : productionLogin && hostnamesStage != 'certificates'
      ? fail('production Ansattporten knows only login.apps.genki.digdir.cloud; set HOSTNAMES_STAGE=certificates first')
      : issuer
param altinnResource = productionLogin
  ? 'urn:altinn:resource:digdir-genai-platform'
  : 'urn:altinn:resource:digdir-genai-platform-test'
param altinnPdpUrl = productionLogin && !empty(altinnPdp)
  ? fail('test signs in through production Ansattporten without Altinn; delete ALTINN_PDP_URL')
  : altinnPdp
param altinnPdpMaskinportenClientId = readEnvironmentVariable('ALTINN_PDP_MASKINPORTEN_CLIENT_ID', '')
param maskinportenIssuer = readEnvironmentVariable('MASKINPORTEN_ISSUER', '')
param maskinportenTokenUrl = readEnvironmentVariable('MASKINPORTEN_TOKEN_URL', '')
param altinnPeopleUrl = altinnPeople
param altinnPeopleMaskinportenClientId = altinnPeopleClient
param altinnPeopleMaskinportenScope = readEnvironmentVariable('ALTINN_PEOPLE_MASKINPORTEN_SCOPE', '')
param operatorSubjects = readEnvironmentVariable('OPERATOR_SUBJECTS', '')
var platformOrgSet = readEnvironmentVariable('PLATFORM_TENANT', '')
var platformOrg = empty(platformOrgSet) ? '991825827' : platformOrgSet
param platformTenant = platformOrg

// The names moved to genki.digdir.cloud; those under genki-test.digdir.cloud stay bound and redirect (infra/README.md, "Moving to a new zone").
var stage = readEnvironmentVariable('HOSTNAMES_STAGE', '')
var hostnamesStage = empty(stage) ? 'none' : stage
param hostnames = {
  api: 'api.genki.digdir.cloud'
  portal: 'portal.genki.digdir.cloud'
  workspace: 'workspace.genki.digdir.cloud'
  console: 'console.genki.digdir.cloud'
  assistant: 'assistant.genki.digdir.cloud'
}
param customDomainsStage = hostnamesStage
param existingCertificates = {}
param createDnsZone = true
param dnsZoneName = 'genki.digdir.cloud'
param previousDnsZoneName = 'genki-test.digdir.cloud'
param assistantHostEnabled = true
param assistantBffEnabled = true
param assistantHostnameStage = hostnamesStage
param hostedHostnames = [
  { subdomain: 'kunnskap', tenant: platformOrg, stage: hostnamesStage }
]
// genki's platform login client for hosted Clients without oidc (infra/README.md, "Platform login").
param platformLoginClientId = productionLogin ? 'c0e4a5af-b2e1-4bba-9324-4caf55be8db5' : 'dde98722-c952-4172-a5d6-10bdf721680f'
param platformLoginSecretName = productionLogin ? 'platform-login-client-secret-prod' : 'platform-login-client-secret'
param platformLoginStage = hostnamesStage
param hostnameBinderEnabled = readEnvironmentVariable('HOSTNAME_BINDER_ENABLED', 'true') != 'false'
param hostnameBinderAudience = readEnvironmentVariable('HOSTNAME_BINDER_AUDIENCE', '')

param alertsEnabled = true
param alertEmails = readEnvironmentVariable('ALERT_EMAILS', '')
param alertMailMaxSeverity = 1
param healthCheckFrequencySeconds = 300
// Off until the deploy identity may write a rule scoped to the subscription (infra/README.md, "Backups").
param serviceHealthAlertEnabled = false
param infraBudgetAmount = 5000
param modelsBudgetAmount = 8000
// Empty until the deploy identity has Cost Management Contributor on rg-genki-test-swc (infra/README.md, "Backups").
param modelsBudgetResourceGroup = ''
