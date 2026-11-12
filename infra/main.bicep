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
param appVersion string = 'bootstrap'

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

@description('Custom hostnames: api, portal, workspace, console. Empty strings use the generated Container Apps hostnames.')
param hostnames object = { api: '', portal: '', workspace: '', console: '' }

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

param addressPrefix string = '10.40.0.0/16'
param appsSubnetPrefix string = '10.40.0.0/23'
param postgresSubnetPrefix string = '10.40.2.0/24'

@description('none: nothing of the knowledge server. server: the server, its network, the knowledge identities and the principals job. apps: also the API and worker settings for it.')
@allowed(['none', 'server', 'apps'])
param knowledgeServerStage string = 'none'

@description('The knowledge database on this environment\'s knowledge server.')
param knowledgeDatabaseName string = 'genai_knowledge'
param knowledgePostgresSkuName string = 'Standard_D2ds_v5'
param knowledgePostgresSkuTier string = 'GeneralPurpose'
param knowledgePostgresStorageSizeGB int = 64

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
  modelFailures: 5
  ingestionFailures: 1
  altinnFailures: 3
  loginKeyFailures: 1
}

param minReplicas int = 1
param maxReplicas int = 3
param cpu string = '0.5'
param memory string = '1Gi'

var baseName = '${namePrefix}-${environmentName}'
var suffix = uniqueString(resourceGroup().id)
var allTags = union(tags, { system: 'genki', environment: environmentName })
var postgresServerName = '${baseName}-pg-${suffix}'

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${baseName}-api-id'
  location: location
  tags: allTags
}

module network 'modules/network.bicep' = {
  name: 'network'
  params: {
    name: '${baseName}-vnet'
    location: location
    tags: allTags
    addressPrefix: addressPrefix
    appsSubnetPrefix: appsSubnetPrefix
    postgresSubnetPrefix: postgresSubnetPrefix
    postgresServerName: postgresServerName
  }
}

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    name: baseName
    location: location
    tags: allTags
    retentionInDays: logRetentionInDays
  }
}

module registry 'modules/registry.bicep' = {
  name: 'registry'
  params: {
    name: take('${namePrefix}${environmentName}${suffix}', 50)
    location: location
    tags: allTags
    pullPrincipalId: appIdentity.properties.principalId
    pushPrincipalId: deployPrincipalId
  }
}

module vault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    name: take('${baseName}-kv-${suffix}', 24)
    location: location
    tags: allTags
    readerPrincipalId: appIdentity.properties.principalId
    publicNetworkAccess: keyVaultPublicNetworkAccess
  }
}

module postgres 'modules/postgres.bicep' = {
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
    databaseNames: ['genai']
    delegatedSubnetId: network.outputs.postgresSubnetId
    privateDnsZoneId: network.outputs.postgresDnsZoneId
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

module knowledgeNetwork 'modules/knowledge-network.bicep' = if (knowledgeOn) {
  name: 'knowledge-network'
  params: {
    name: knowledgeVnetName
    location: location
    tags: allTags
    addressPrefix: knowledgeAddressPrefix
    serverName: knowledgeServerName
    environmentVnetId: network.outputs.vnetId
  }
}

// The environment's side of the peering.
module knowledgePeering 'modules/peering.bicep' = if (knowledgeOn) {
  name: 'knowledge-peering'
  params: {
    vnetName: '${baseName}-vnet'
    name: 'to-${knowledgeVnetName}'
    remoteVnetId: knowledgeOn ? knowledgeNetwork!.outputs.vnetId : ''
  }
}

module knowledgePostgres 'modules/postgres.bicep' = if (knowledgeOn) {
  name: 'knowledge-postgres'
  params: {
    name: knowledgeServerName
    location: location
    tags: allTags
    version: postgresVersion
    skuName: knowledgePostgresSkuName
    skuTier: knowledgePostgresSkuTier
    storageSizeGB: knowledgePostgresStorageSizeGB
    backupRetentionDays: knowledgePostgresBackupRetentionDays
    geoRedundantBackup: knowledgePostgresGeoRedundantBackup
    highAvailability: knowledgePostgresHighAvailability
    databaseNames: [knowledgeDatabaseName]
    delegatedSubnetId: knowledgeOn ? knowledgeNetwork!.outputs.subnetId : ''
    privateDnsZoneId: knowledgeOn ? knowledgeNetwork!.outputs.dnsZoneId : ''
    adminGroupObjectId: postgresAdminGroupObjectId
    adminGroupName: postgresAdminGroupName
    identityAdmins: knowledgeOn
      ? [{ principalId: knowledgeAdminIdentity!.properties.principalId, name: knowledgeAdminIdentity!.name }]
      : []
    extensions: 'VECTOR,PG_PREWARM'
    sharedPreloadLibraries: 'pg_stat_statements,pg_prewarm'
  }
}

var knowledgeHost = knowledgeOn ? knowledgePostgres!.outputs.fqdn : ''

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

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    name: take('${namePrefix}${environmentName}data${suffix}', 24)
    location: location
    tags: allTags
  }
}

module apps 'modules/containerapps.bicep' = {
  name: 'containerapps'
  params: {
    name: baseName
    environmentName: environmentName
    location: location
    tags: allTags
    appsSubnetId: network.outputs.appsSubnetId
    workspaceId: monitoring.outputs.workspaceId
    insightsName: monitoring.outputs.insightsName
    identityId: appIdentity.id
    identityClientId: appIdentity.properties.clientId
    identityName: appIdentity.name
    registryServer: registry.outputs.loginServer
    keyVaultUri: vault.outputs.uri
    keyVaultSecretNames: keyVaultSecretNames
    apiImage: apiImage
    workerImage: workerImage
    appsImage: appsImage
    appVersion: appVersion
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
      OPERATOR_SUBJECTS: operatorSubjects
      PLATFORM_TENANT: platformTenant
      EMPLOYEE_CLIENT_IDS: join(filter([portalClientId, workspaceClientId, consoleClientId], id => !empty(id)), ',')
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
    storageAccountName: storage.outputs.name
    storageShareName: storage.outputs.shareName
    hostnames: hostnames
    customDomainsStage: customDomainsStage
    existingCertificates: existingCertificates
    postgresHost: postgres.outputs.fqdn
    postgresDatabase: postgres.outputs.databaseName
    knowledge: knowledgeServerStage == 'apps'
      ? {
          host: knowledgeHost
          database: knowledgeDatabaseName
          vcores: knowledgePostgresVCores
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
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    cpu: cpu
    memory: memory
  }
}

module alerts 'modules/alerts.bicep' = if (alertsEnabled) {
  name: 'alerts'
  params: {
    name: baseName
    environmentName: environmentName
    location: location
    tags: allTags
    workspaceId: monitoring.outputs.workspaceId
    insightsName: monitoring.outputs.insightsName
    apiAppName: apps.outputs.appName
    workerAppName: apps.outputs.workerName
    healthUrl: 'https://${customDomainsStage == 'certificates' && !empty(hostnames.api) ? hostnames.api : apps.outputs.fqdn}/health'
    emails: alertEmails
    healthCheckFrequencySeconds: healthCheckFrequencySeconds
    thresholds: alertThresholds
  }
}

var zoneSuffix = '.${dnsZoneName}'
var zoneApps = filter(['api', 'portal', 'workspace', 'console'], app => !empty(hostnames[app]) && endsWith(hostnames[app], zoneSuffix))

module dns 'modules/dns.bicep' = if (createDnsZone && !empty(dnsZoneName)) {
  name: 'dns'
  params: {
    zoneName: dnsZoneName
    tags: allTags
    verificationId: apps.outputs.verificationId
    records: [for app in zoneApps: {
      label: replace(hostnames[app], zoneSuffix, '')
      target: apps.outputs.defaultFqdns[app]
    }]
  }
}

output apiUrl string = 'https://${apps.outputs.fqdn}'
output appUrls object = apps.outputs.defaultFqdns
output customDomainVerificationId string = apps.outputs.verificationId
output dnsNameServers array = createDnsZone && !empty(dnsZoneName) ? dns!.outputs.nameServers : []
output containerAppName string = apps.outputs.appName
output workerAppName string = apps.outputs.workerName
output registryName string = registry.outputs.name
output registryLoginServer string = registry.outputs.loginServer
output keyVaultName string = vault.outputs.name
output postgresHost string = postgres.outputs.fqdn
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
