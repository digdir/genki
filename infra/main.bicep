targetScope = 'resourceGroup'

@allowed(['test', 'prod'])
param environmentName string
param namePrefix string = 'genai'
param location string = resourceGroup().location
param tags object = {}

@description('Container images by digest, e.g. <registry>.azurecr.io/genai-api@sha256:...')
param apiImage string = 'mcr.microsoft.com/k8se/quickstart:latest'
param workerImage string = 'mcr.microsoft.com/k8se/quickstart:latest'
param appsImage string = 'mcr.microsoft.com/k8se/quickstart:latest'
param doclingImage string = 'mcr.microsoft.com/k8se/quickstart:latest'
param appVersion string = 'bootstrap'
@description('The worker\'s APP_VERSION; empty means appVersion.')
param workerVersion string = ''

@description('API revisions (deploy.yml): the new one\'s suffix, the one users get, and the one before it. Empty live: one revision.')
param apiRevisionSuffix string = ''
param apiLiveRevision string = ''
param apiPreviousRevision string = ''

@description('false: deploy the identities and the container apps only, and read the network, registry, vault, storage and servers as they are. deploy.yml passes false when infraFingerprint matches the last full deploy.')
param deployInfrastructure bool = true

@description('A hash of the compiled template and this environment\'s settings (deploy.yml, infra.yml), kept in the outputs to tell whether the infrastructure changed since.')
param infraFingerprint string = ''

@description('Plain settings for the api and worker, e.g. FOUNDRY_OPENAI_BASE_URL, TYPESENSE_URL.')
param appEnv object = {}

@description('Ansattporten issuer for people. Required outside development mode.')
param ansattportenIssuer string = ''
param ansattportenJwksUri string = ''
param apiAudience string = 'digdir:genai'
param altinnResource string = 'urn:altinn:resource:digdir-genai-platform'

@description('Altinn decision point. Required outside development mode.')
param altinnPdpUrl string = ''
param altinnPdpMaskinportenClientId string = ''
param maskinportenIssuer string = ''
param maskinportenJwksUri string = ''
param maskinportenTokenUrl string = ''
param maskinportenRequiredScope string = ''

@description('Altinn access management for the Tilgang people list (ADR 0060). Empty leaves it off.')
param altinnPeopleUrl string = ''
param altinnPeopleMaskinportenClientId string = ''
param altinnPeopleMaskinportenScope string = ''

@description('Comma-separated person identifiers that get the operator role.')
param operatorSubjects string = ''

@description('Organisation number that plays Digdir: owns the seeded services, shared services and platform tasks. Empty means Digdir.')
param platformTenant string = ''

@description('Ansattporten client ids for the three apps, and the console login settings.')
param portalClientId string = ''
param workspaceClientId string = ''
param consoleClientId string = ''
param consoleIssuer string = ansattportenIssuer
param consoleTokenEndpoint string = ''

@description('Custom hostnames: api, portal, workspace, console, and assistant for the assistant host. Empty strings use the generated Container Apps hostnames.')
param hostnames object = { api: '', portal: '', workspace: '', console: '', assistant: '' }

@description('none: no custom domains. hostnames: add them without certificates (DNS must exist). certificates: managed certificates, run after hostnames.')
@allowed(['none', 'hostnames', 'certificates'])
param customDomainsStage string = 'none'

@description('Managed certificates that already exist in the environment, by app (api, portal, workspace, console). The certificates stage binds these instead of creating its own.')
param existingCertificates object = {}

@description('Create an Azure DNS zone for the hostnames, with the CNAME and validation records. Delegate it from the parent zone.')
param createDnsZone bool = false
param dnsZoneName string = ''

@description('Key Vault secret names the api reads. Each becomes an env var and resolves as secret://env/<name>.')
param keyVaultSecretNames array = []
param keyVaultPublicNetworkAccess string = 'Enabled'

@description('Object id of the principal that runs deployments; gets AcrPush. Empty to skip.')
param deployPrincipalId string = ''

param postgresAdminGroupObjectId string
param postgresAdminGroupName string
param appIdentityIsPostgresAdmin bool = false
param postgresVersion string = '17'
param postgresSkuName string = 'Standard_B1ms'
param postgresSkuTier string = 'Burstable'
param postgresStorageSizeGB int = 32

@minValue(7)
@maxValue(35)
param postgresBackupRetentionDays int = 7

@description('Copies backups to the paired region. Azure sets this only when the server is created.')
@allowed(['Enabled', 'Disabled'])
param postgresGeoRedundantBackup string = 'Disabled'

@allowed(['Disabled', 'SameZone', 'ZoneRedundant'])
param postgresHighAvailability string = 'Disabled'

@description('The platform server\'s maintenance window in UTC: { customWindow: \'Enabled\', dayOfWeek (0 is Sunday), startHour, startMinute }. The default is Azure\'s own choice of time.')
param postgresMaintenanceWindow object = { customWindow: 'Disabled', dayOfWeek: 0, startHour: 0, startMinute: 0 }

@description('CanNotDelete locks on the platform server, the storage accounts and Key Vault. Writing a lock takes Owner or User Access Administrator, which the deploy identity does not have (infra/README.md, "Backups").')
param resourceLocksEnabled bool = false

@description('A daily backup of the file share in a Recovery Services vault, and a nightly copy of the platform database in a storage account of its own (docs/runbook.md, "Backups").')
param backupsEnabled bool = false

@description('The image the nightly copy runs pg_dump in, by digest, at postgresVersion\'s major version.')
param pgDumpImage string = 'docker.io/library/postgres:17.12-bookworm@sha256:837bed18782820fe967067cb5328b02b0d9992c1be9a37ee0c9c492cfc03af3b'

@description('true once the copies\' immutability policy is locked by hand (docs/runbook.md, "Backups").')
param platformBackupImmutabilityLocked bool = false

@description('When the nightly copy runs, as cron in UTC.')
param platformBackupSchedule string = '30 1 * * *'

param addressPrefix string = '10.40.0.0/16'
param appsSubnetPrefix string = '10.40.0.0/23'
param postgresSubnetPrefix string = '10.40.2.0/24'
@description('A subnet for private endpoints, which backupsEnabled needs; empty for none.')
param endpointsSubnetPrefix string = ''

@description('none: nothing of the knowledge server. server: the server, its network, the knowledge identities and the principals job. apps: also the API and worker settings for it.')
@allowed(['none', 'server', 'apps'])
param knowledgeServerStage string = 'none'

@description('The knowledge database on this environment\'s knowledge server.')
param knowledgeDatabaseName string = 'genai_knowledge'
param knowledgePostgresSkuName string = 'Standard_D2ds_v5'
param knowledgePostgresSkuTier string = 'GeneralPurpose'
param knowledgePostgresStorageSizeGB int = 64

@description('The knowledge disk\'s performance tier, such as P30; empty sends none. See infra/README.md, "Disk tier".')
param knowledgePostgresPerformanceTier string = ''

@description('The vCores of knowledgePostgresSkuName, for the worker (KNOWLEDGE_VCORES).')
param knowledgePostgresVCores int = 2

@minValue(7)
@maxValue(35)
param knowledgePostgresBackupRetentionDays int = 7

@description('Azure sets this only when the server is created.')
@allowed(['Enabled', 'Disabled'])
param knowledgePostgresGeoRedundantBackup string = 'Disabled'

@allowed(['Disabled', 'SameZone', 'ZoneRedundant'])
param knowledgePostgresHighAvailability string = 'Disabled'

@description('The knowledge server\'s own network, peered with this environment\'s.')
param knowledgeAddressPrefix string = '10.42.0.0/24'

param logRetentionInDays int = 30

@description('Alert rules, the API availability test and the action group. See docs/runbook.md.')
param alertsEnabled bool = false

@description('Email addresses for alerts, comma separated. Empty means alerts fire without notifying anyone.')
param alertEmails string = ''

@description('How often the availability test calls /health, in seconds.')
@allowed([300, 900])
param healthCheckFrequencySeconds int = 300

param alertThresholds object = {
  errorRatePercent: 5
  errorRateMinRequests: 20
  latencySeconds: 5
  latencyMinRequests: 50
  modelFailures: 5
  queueWaitMinutes: 30
  workerFailures: 3
  altinnFailures: 3
  loginKeyFailures: 1
}

@description('Deploys the generic assistant host (ADR 0061) in its own environment, with its own identity and Key Vault (ADR 0062).')
param assistantHostEnabled bool = false
@description('A Service Health alert for the services genki uses. Its rule is scoped to the subscription, where the deploy identity has no role (infra/README.md, "Backups").')
param serviceHealthAlertEnabled bool = false

@description('Monthly budgets in the billing currency, notifying the alerts\' action group: infra on this resource group, models on modelsBudgetResourceGroup. 0 or empty: none.')
param infraBudgetAmount int = 0
param modelsBudgetAmount int = 0
@description('The resource group the models run in. The deploy identity needs Cost Management Contributor there.')
param modelsBudgetResourceGroup string = ''
@description('The first of a month; Azure refuses to change a budget\'s start later.')
param budgetStartDate string = '2026-11-01'

@description('Turns on the BFF for the assistant host (ADR 0061): put the same genai-proxy-key in genki\'s and the host\'s Key Vault first.')
param assistantBffEnabled bool = false

@description('The stage of hostnames.assistant on the assistant host, as customDomainsStage: none, hostnames or certificates. A new host starts at none, since Azure binds a name only once its DNS points at the host.')
@allowed(['none', 'hostnames', 'certificates'])
param assistantHostnameStage string = customDomainsStage

@description('Hostnames the assistant host serves, each { hostname or subdomain, tenant, stage, apex? }: a subdomain becomes <subdomain>.apps.<dnsZoneName>, stage as customDomainsStage, apex for a zone apex. See infra/README.md, "Hosted hostnames".')
param hostedHostnames array = []

param minReplicas int = 1
param maxReplicas int = 3
@description('Most connections each of an API replica\'s two pools opens to the platform database (DATABASE_POOL_MAX).')
@minValue(3)
param apiDatabasePoolMax int = 10
@description('Most connections each of the worker\'s two pools opens to the platform database (DATABASE_POOL_MAX).')
@minValue(3)
param workerDatabasePoolMax int = 10
@description('Multiple lets the deploy stop the old worker revision before the new one starts (scripts/worker-revisions.sh).')
@allowed(['Single', 'Multiple'])
param workerRevisionsMode string = 'Single'
@description('The API\'s cores and memory a replica.')
param cpu string = '0.5'
param memory string = '1Gi'
@description('The worker\'s cores and memory, apart from the API: a Kudos listing ran out of 1 GiB (issue 338).')
param workerCpu string = '2'
@description('In whole Gi: the worker\'s heap is three quarters of it.')
param workerMemory string = '4Gi'

var postgresConnections = loadJsonContent('postgres-connections.json')
var baseName = '${namePrefix}-${environmentName}'
var assignedNames = filter(hostedHostnames, h => !empty(h.?subdomain ?? ''))
var hostedNames = map(hostedHostnames, h => union(h, {
  hostname: toLower(empty(h.?subdomain ?? '') ? h.hostname : '${h.subdomain}.apps.${dnsZoneName}')
}))
var assistantNames = empty(hostnames.?assistant ?? '') || empty(platformTenant)
  ? []
  : [{ hostname: toLower(hostnames.assistant), tenant: platformTenant, stage: assistantHostnameStage }]
var servedNames = concat(hostedNames, assistantNames)
var suffix = uniqueString(resourceGroup().id)
var allTags = union(tags, { system: 'genki', environment: environmentName })
var postgresServerName = '${baseName}-pg-${suffix}'
var registryName = take('${namePrefix}${environmentName}${suffix}', 50)
var vaultName = take('${baseName}-kv-${suffix}', 24)
var storageName = take('${namePrefix}${environmentName}data${suffix}', 24)
var infra = deployInfrastructure
var platformBackupStorageName = take('${namePrefix}${environmentName}bak${suffix}', 24)
var platformBackupContainer = 'platform'
var platformDatabase = 'genai'

// Read only behind `infra ?`, as is every infrastructure module's output (infra/README.md, "Deploys that skip the infrastructure").
resource existingRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}
resource existingVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: vaultName
}
resource existingStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageName
}
resource existingPostgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' existing = {
  name: postgresServerName
}

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${baseName}-api-id'
  location: location
  tags: allTags
}

resource backupIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (backupsEnabled) {
  name: '${baseName}-backup-id'
  location: location
  tags: allTags
}

module network 'modules/network.bicep' = if (infra) {
  name: 'network'
  params: {
    name: '${baseName}-vnet'
    location: location
    tags: allTags
    addressPrefix: addressPrefix
    appsSubnetPrefix: appsSubnetPrefix
    postgresSubnetPrefix: postgresSubnetPrefix
    endpointsSubnetPrefix: endpointsSubnetPrefix
    postgresServerName: postgresServerName
  }
}

module monitoring 'modules/monitoring.bicep' = if (infra) {
  name: 'monitoring'
  params: {
    name: baseName
    location: location
    tags: allTags
    retentionInDays: logRetentionInDays
  }
}

module registry 'modules/registry.bicep' = if (infra) {
  name: 'registry'
  params: {
    name: registryName
    location: location
    tags: allTags
    pullPrincipalId: appIdentity.properties.principalId
    pushPrincipalId: deployPrincipalId
  }
}

module vault 'modules/keyvault.bicep' = if (infra) {
  name: 'keyvault'
  params: {
    name: vaultName
    location: location
    tags: allTags
    readerPrincipalId: appIdentity.properties.principalId
    publicNetworkAccess: keyVaultPublicNetworkAccess
  }
}

module postgres 'modules/postgres.bicep' = if (infra) {
  name: 'postgres'
  params: {
    name: postgresServerName
    location: location
    tags: allTags
    version: postgresVersion
    skuName: postgresSkuName
    skuTier: postgresSkuTier
    storageSizeGB: postgresStorageSizeGB
    backupRetentionDays: postgresBackupRetentionDays
    geoRedundantBackup: postgresGeoRedundantBackup
    highAvailability: postgresHighAvailability
    maintenanceWindow: postgresMaintenanceWindow
    maxConnections: postgresConnections.maxConnections[postgresSkuName]
    databaseNames: [platformDatabase]
    delegatedSubnetId: infra ? network!.outputs.postgresSubnetId : ''
    privateDnsZoneId: infra ? network!.outputs.postgresDnsZoneId : ''
    adminGroupObjectId: postgresAdminGroupObjectId
    adminGroupName: postgresAdminGroupName
    identityAdmins: appIdentityIsPostgresAdmin
      ? [{ principalId: appIdentity.properties.principalId, name: appIdentity.name }]
      : []
  }
}

// The knowledge server (ADR 0042): one per environment, set up as the platform server is, in a network of its own
// peered with the environment's. A server cannot move network once made, so a network peered with it later
// reaches the knowledge server and not the environment's network.
var knowledgeOn = knowledgeServerStage != 'none'
var knowledgeServerName = '${baseName}-knowledge-${suffix}'
var knowledgeVnetName = '${baseName}-knowledge-vnet'
// Azure evaluates the reference functions of a resource it does not deploy, and fails on one that does not exist, so
// each read of a knowledge resource's outputs or properties sits behind `knowledgeOn ?`, even in a conditional module
// (Bicep: conditional deployment, runtime functions).

resource knowledgeApiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (knowledgeOn) {
  name: '${baseName}-knowledge-api-id'
  location: location
  tags: allTags
}

resource knowledgeWorkerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (knowledgeOn) {
  name: '${baseName}-knowledge-worker-id'
  location: location
  tags: allTags
}

resource knowledgeAdminIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (knowledgeOn) {
  name: '${baseName}-knowledge-admin-id'
  location: location
  tags: allTags
}

module knowledgeNetwork 'modules/knowledge-network.bicep' = if (knowledgeOn && infra) {
  name: 'knowledge-network'
  params: {
    name: knowledgeVnetName
    location: location
    tags: allTags
    addressPrefix: knowledgeAddressPrefix
    serverName: knowledgeServerName
    environmentVnetId: infra ? network!.outputs.vnetId : ''
  }
}

// The environment's side of the peering.
module knowledgePeering 'modules/peering.bicep' = if (knowledgeOn && infra) {
  name: 'knowledge-peering'
  params: {
    vnetName: '${baseName}-vnet'
    name: 'to-${knowledgeVnetName}'
    remoteVnetId: knowledgeOn && infra ? knowledgeNetwork!.outputs.vnetId : ''
  }
}

module knowledgePostgres 'modules/postgres.bicep' = if (knowledgeOn && infra) {
  name: 'knowledge-postgres'
  params: {
    name: knowledgeServerName
    location: location
    tags: allTags
    version: postgresVersion
    skuName: knowledgePostgresSkuName
    skuTier: knowledgePostgresSkuTier
    storageSizeGB: knowledgePostgresStorageSizeGB
    performanceTier: knowledgePostgresPerformanceTier
    backupRetentionDays: knowledgePostgresBackupRetentionDays
    geoRedundantBackup: knowledgePostgresGeoRedundantBackup
    highAvailability: knowledgePostgresHighAvailability
    databaseNames: [knowledgeDatabaseName]
    delegatedSubnetId: knowledgeOn && infra ? knowledgeNetwork!.outputs.subnetId : ''
    privateDnsZoneId: knowledgeOn && infra ? knowledgeNetwork!.outputs.dnsZoneId : ''
    adminGroupObjectId: postgresAdminGroupObjectId
    adminGroupName: postgresAdminGroupName
    identityAdmins: knowledgeOn
      ? [{ principalId: knowledgeAdminIdentity!.properties.principalId, name: knowledgeAdminIdentity!.name }]
      : []
    extensions: 'VECTOR,PG_PREWARM'
    sharedPreloadLibraries: 'pg_stat_statements,pg_prewarm'
  }
}

resource existingKnowledgePostgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' existing = {
  name: knowledgeServerName
}

var knowledgeHost = !knowledgeOn
  ? ''
  : infra ? knowledgePostgres!.outputs.fqdn : existingKnowledgePostgres.properties.fullyQualifiedDomainName

// The principals job: makes the two logins by object id and sets up the database, as the knowledge admin.
var knowledgeSetup = knowledgeOn
  ? {
      host: knowledgeHost
      admin: { id: knowledgeAdminIdentity!.id, clientId: knowledgeAdminIdentity!.properties.clientId }
      args: [
        '--principals'
        '--admin-user'
        knowledgeAdminIdentity!.name
        '--database'
        knowledgeDatabaseName
        '--api-login'
        knowledgeApiIdentity!.name
        '--api-object-id'
        knowledgeApiIdentity!.properties.principalId
        '--worker-login'
        knowledgeWorkerIdentity!.name
        '--worker-object-id'
        knowledgeWorkerIdentity!.properties.principalId
      ]
    }
  : {}

module storage 'modules/storage.bicep' = if (infra) {
  name: 'storage'
  params: {
    name: storageName
    location: location
    tags: allTags
    conversionsWriterPrincipalId: knowledgeOn ? knowledgeWorkerIdentity!.properties.principalId : ''
  }
}

module filesBackup 'modules/files-backup.bicep' = if (backupsEnabled && infra) {
  name: 'files-backup'
  params: {
    name: '${baseName}-files-rsv'
    location: location
    tags: allTags
    storageAccountName: storageName
    shareName: infra ? storage!.outputs.shareName : 'data'
  }
}

module platformBackup 'modules/platform-backup.bicep' = if (backupsEnabled && infra) {
  name: 'platform-backup'
  params: {
    name: platformBackupStorageName
    location: location
    tags: allTags
    writerPrincipalId: backupsEnabled ? backupIdentity!.properties.principalId : ''
    containerName: platformBackupContainer
    vnetId: infra ? network!.outputs.vnetId : ''
    endpointsSubnetId: infra ? network!.outputs.endpointsSubnetId : ''
    immutabilityLocked: platformBackupImmutabilityLocked
  }
}

module apps 'modules/containerapps.bicep' = {
  name: 'containerapps'
  params: {
    name: baseName
    environmentName: environmentName
    location: location
    tags: allTags
    appsSubnetId: infra
      ? network!.outputs.appsSubnetId
      : resourceId('Microsoft.Network/virtualNetworks/subnets', '${baseName}-vnet', 'apps')
    workspaceId: infra
      ? monitoring!.outputs.workspaceId
      : resourceId('Microsoft.OperationalInsights/workspaces', '${baseName}-logs')
    insightsName: infra ? monitoring!.outputs.insightsName : '${baseName}-insights'
    identityId: appIdentity.id
    identityClientId: appIdentity.properties.clientId
    identityName: appIdentity.name
    registryServer: infra ? registry!.outputs.loginServer : existingRegistry.properties.loginServer
    keyVaultUri: infra ? vault!.outputs.uri : existingVault.properties.vaultUri
    keyVaultSecretNames: keyVaultSecretNames
    bffProxyKey: assistantHostEnabled && assistantBffEnabled
    apiImage: apiImage
    apiRevisionSuffix: apiRevisionSuffix
    apiLiveRevision: apiLiveRevision
    apiPreviousRevision: apiPreviousRevision
    workerImage: workerImage
    appsImage: appsImage
    doclingImage: doclingImage
    appVersion: appVersion
    workerVersion: workerVersion
    appEnv: appEnv
    identityEnv: {
      ANSATTPORTEN_ISSUER: ansattportenIssuer
      ANSATTPORTEN_JWKS_URI: ansattportenJwksUri
      API_AUDIENCE: apiAudience
      ALTINN_RESOURCE: altinnResource
      ALTINN_PDP_URL: altinnPdpUrl
      ALTINN_PDP_MASKINPORTEN_CLIENT_ID: altinnPdpMaskinportenClientId
      MASKINPORTEN_ISSUER: maskinportenIssuer
      MASKINPORTEN_JWKS_URI: maskinportenJwksUri
      MASKINPORTEN_TOKEN_URL: maskinportenTokenUrl
      MASKINPORTEN_REQUIRED_SCOPE: maskinportenRequiredScope
      ALTINN_PEOPLE_URL: altinnPeopleUrl
      ALTINN_PEOPLE_MASKINPORTEN_CLIENT_ID: altinnPeopleMaskinportenClientId
      ALTINN_PEOPLE_MASKINPORTEN_SCOPE: altinnPeopleMaskinportenScope
      OPERATOR_SUBJECTS: operatorSubjects
      PLATFORM_TENANT: platformTenant
      EMPLOYEE_CLIENT_IDS: join(filter([portalClientId, workspaceClientId, consoleClientId], id => !empty(id)), ',')
      GENAI_HOSTED_HOSTNAMES: join(map(servedNames, h => '${h.hostname}=${h.tenant}'), ',')
      GENAI_ASSISTANT_HOSTNAME: assistantHostEnabled ? (hostnames.?assistant ?? '') : ''
    }
    webSettings: {
      ansattportenIssuer: ansattportenIssuer
      apiAudience: apiAudience
      altinnResource: altinnResource
      portalClientId: portalClientId
      workspaceClientId: workspaceClientId
      consoleClientId: consoleClientId
      consoleIssuer: consoleIssuer
      consoleTokenEndpoint: consoleTokenEndpoint
    }
    storageAccountName: storageName
    storageShareName: infra ? storage!.outputs.shareName : 'data'
    hostnames: hostnames
    customDomainsStage: customDomainsStage
    existingCertificates: existingCertificates
    postgresHost: infra ? postgres!.outputs.fqdn : existingPostgres.properties.fullyQualifiedDomainName
    postgresDatabase: platformDatabase
    knowledge: knowledgeServerStage == 'apps'
      ? {
          host: knowledgeHost
          database: knowledgeDatabaseName
          vcores: knowledgePostgresVCores
          conversionsUrl: infra
            ? storage!.outputs.conversionsUrl
            : '${existingStorage.properties.primaryEndpoints.blob}conversions'
          api: {
            id: knowledgeApiIdentity!.id
            clientId: knowledgeApiIdentity!.properties.clientId
            name: knowledgeApiIdentity!.name
          }
          worker: {
            id: knowledgeWorkerIdentity!.id
            clientId: knowledgeWorkerIdentity!.properties.clientId
            name: knowledgeWorkerIdentity!.name
          }
        }
      : {}
    knowledgeSetup: knowledgeSetup
    platformBackup: backupsEnabled
      ? {
          pgDumpImage: pgDumpImage
          schedule: platformBackupSchedule
          writer: { id: backupIdentity!.id, clientId: backupIdentity!.properties.clientId }
          containerUrl: 'https://${platformBackupStorageName}.blob.${environment().suffixes.storage}/${platformBackupContainer}'
          drillHost: '${baseName}-pg-restore-drill.postgres.database.azure.com'
        }
      : {}
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    apiDatabasePoolMax: apiDatabasePoolMax
    workerDatabasePoolMax: workerDatabasePoolMax
    workerRevisionsMode: workerRevisionsMode
    cpu: cpu
    memory: memory
    workerCpu: workerCpu
    workerMemory: workerMemory
  }
}

module assistantHostInfra 'modules/assistant-host-infra.bicep' = if (assistantHostEnabled && infra) {
  name: 'assistant-host-infra'
  params: {
    name: baseName
    location: location
    tags: allTags
    workspaceId: infra
      ? monitoring!.outputs.workspaceId
      : resourceId('Microsoft.OperationalInsights/workspaces', '${baseName}-logs')
    registryName: registryName
    keyVaultPublicNetworkAccess: keyVaultPublicNetworkAccess
  }
}

module assistantHost 'modules/assistant-host.bicep' = if (assistantHostEnabled) {
  name: 'assistant-host'
  dependsOn: [assistantHostInfra]
  params: {
    name: baseName
    location: location
    tags: allTags
    registryName: registryName
    appsImage: appsImage
    apiUpstream: 'https://${apps.outputs.fqdn}'
    ansattportenIssuer: ansattportenIssuer
    bffProxyKey: assistantBffEnabled
    hostedHostnames: servedNames
  }
}

module alerts 'modules/alerts.bicep' = if (alertsEnabled && infra) {
  name: 'alerts'
  params: {
    name: baseName
    environmentName: environmentName
    location: location
    tags: allTags
    workspaceId: infra ? monitoring!.outputs.workspaceId : ''
    insightsName: infra ? monitoring!.outputs.insightsName : ''
    apiAppName: apps.outputs.appName
    workerAppName: apps.outputs.workerName
    healthUrl: 'https://${customDomainsStage == 'certificates' && !empty(hostnames.api) ? hostnames.api : apps.outputs.fqdn}/health'
    emails: alertEmails
    healthCheckFrequencySeconds: healthCheckFrequencySeconds
    thresholds: alertThresholds
    postgresServerId: infra ? postgres!.outputs.id : ''
    postgresUserConnections: postgresConnections.maxConnections[postgresSkuName] - postgresConnections.reservedConnections
    backupJobName: apps.outputs.platformBackupJobName
    serviceHealthAlert: serviceHealthAlertEnabled
  }
}

var budgetNotifications = [
  { threshold: 80, type: 'Actual' }
  { threshold: 100, type: 'Actual' }
  { threshold: 100, type: 'Forecasted' }
]
module infraBudget 'modules/budget.bicep' = if (alertsEnabled && infra && infraBudgetAmount > 0) {
  name: 'budget-infra'
  params: {
    name: 'budget-genki-infra'
    amount: infraBudgetAmount
    startDate: budgetStartDate
    actionGroupId: alertsEnabled && infra ? alerts!.outputs.actionGroupId : ''
    notifications: budgetNotifications
  }
}

module modelsBudget 'modules/budget.bicep' = if (alertsEnabled && infra && modelsBudgetAmount > 0 && !empty(modelsBudgetResourceGroup)) {
  name: 'budget-models'
  scope: resourceGroup(empty(modelsBudgetResourceGroup) ? resourceGroup().name : modelsBudgetResourceGroup)
  params: {
    name: 'budget-genki-models'
    amount: modelsBudgetAmount
    startDate: budgetStartDate
    actionGroupId: alertsEnabled && infra ? alerts!.outputs.actionGroupId : ''
    notifications: budgetNotifications
  }
}

var lockNotes = 'genki: remove only on purpose (docs/runbook.md, "Backups").'
var lockOn = resourceLocksEnabled && infra

resource postgresLock 'Microsoft.Authorization/locks@2020-05-01' = if (lockOn) {
  scope: existingPostgres
  name: 'do-not-delete'
  properties: { level: 'CanNotDelete', notes: lockNotes }
  dependsOn: [postgres]
}

resource storageLock 'Microsoft.Authorization/locks@2020-05-01' = if (lockOn) {
  scope: existingStorage
  name: 'do-not-delete'
  properties: { level: 'CanNotDelete', notes: lockNotes }
  dependsOn: [storage]
}

resource vaultLock 'Microsoft.Authorization/locks@2020-05-01' = if (lockOn) {
  scope: existingVault
  name: 'do-not-delete'
  properties: { level: 'CanNotDelete', notes: lockNotes }
  dependsOn: [vault]
}

resource existingPlatformBackupStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: platformBackupStorageName
}

resource platformBackupLock 'Microsoft.Authorization/locks@2020-05-01' = if (lockOn && backupsEnabled) {
  scope: existingPlatformBackupStorage
  name: 'do-not-delete'
  properties: { level: 'CanNotDelete', notes: lockNotes }
  dependsOn: [platformBackup]
}

var zoneSuffix = '.${dnsZoneName}'
var zoneApps = filter(['api', 'portal', 'workspace', 'console'], app => !empty(hostnames[app]) && endsWith(hostnames[app], zoneSuffix))
var assistantInZone = assistantHostEnabled && endsWith(hostnames.?assistant ?? '', zoneSuffix)
var assistantRecords = assistantInZone
  ? [
      {
        label: replace(hostnames.assistant, zoneSuffix, '')
        target: assistantHost!.outputs.fqdn
        verificationId: assistantHost!.outputs.verificationId
      }
    ]
  : []

module dns 'modules/dns.bicep' = if (createDnsZone && !empty(dnsZoneName) && infra) {
  name: 'dns'
  params: {
    zoneName: dnsZoneName
    tags: allTags
    verificationId: apps.outputs.verificationId
    records: [for app in zoneApps: {
      label: replace(hostnames[app], zoneSuffix, '')
      target: apps.outputs.defaultFqdns[app]
    }]
    otherRecords: assistantRecords
    hostedLabels: assistantHostEnabled ? map(assignedNames, h => '${toLower(h.subdomain)}.apps') : []
    hostedTarget: assistantHostEnabled ? assistantHost!.outputs.fqdn : ''
    hostedVerificationId: assistantHostEnabled ? assistantHost!.outputs.verificationId : ''
  }
}

output apiUrl string = 'https://${apps.outputs.fqdn}'
output apiCandidateUrl string = apps.outputs.apiCandidateUrl
output apiCandidateRevision string = apps.outputs.apiCandidateRevision
output appUrls object = apps.outputs.defaultFqdns
output customDomainVerificationId string = apps.outputs.verificationId
output dnsNameServers array = createDnsZone && !empty(dnsZoneName) && infra ? dns!.outputs.nameServers : []
output containerAppName string = apps.outputs.appName
output workerAppName string = apps.outputs.workerName
output doclingAppName string = apps.outputs.doclingName
output registryName string = registryName
output registryLoginServer string = infra ? registry!.outputs.loginServer : existingRegistry.properties.loginServer
output keyVaultName string = vaultName
output postgresHost string = infra ? postgres!.outputs.fqdn : existingPostgres.properties.fullyQualifiedDomainName
output appIdentityClientId string = appIdentity.properties.clientId
output appIdentityName string = appIdentity.name
output knowledgePostgresHost string = knowledgeOn ? knowledgeHost : ''
output knowledgeApiIdentity object = knowledgeOn
  ? { name: knowledgeApiIdentity!.name, principalId: knowledgeApiIdentity!.properties.principalId }
  : {}
output knowledgeWorkerIdentity object = knowledgeOn
  ? { name: knowledgeWorkerIdentity!.name, principalId: knowledgeWorkerIdentity!.properties.principalId }
  : {}
output knowledgeSetupJobName string = apps.outputs.knowledgeSetupJobName
output platformBackupJobName string = apps.outputs.platformBackupJobName
output assistantHost object = assistantHostEnabled
  ? {
      appName: assistantHost!.outputs.appName
      fqdn: assistantHost!.outputs.fqdn
      staticIp: assistantHost!.outputs.staticIp
      verificationId: assistantHost!.outputs.verificationId
      vaultName: take('${baseName}-hostkv', 24)
      dnsRecords: assistantHost!.outputs.dnsRecords
    }
  : {}
@description('Whether this deploy applied the infrastructure, and the fingerprint it applied: deploy.yml compares the last full deploy\'s fingerprint with its own.')
output infrastructureDeployed bool = infra
output infraFingerprint string = infraFingerprint
