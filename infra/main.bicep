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

@description('none: nothing of the knowledge server. server: the knowledge identities and the principals job, and where createKnowledgeServer is set, the server and its network. apps: also the API and worker settings for it.')
@allowed(['none', 'server', 'apps'])
param knowledgeServerStage string = 'none'

@description('Create the knowledge server here. One server serves test and prod; prod creates it, test sets knowledgePostgresHost.')
param createKnowledgeServer bool = false

@description('The knowledge server\'s host name, where another environment creates it.')
param knowledgePostgresHost string = ''

@description('This environment\'s database on the knowledge server.')
param knowledgeDatabaseName string = 'genai_knowledge'

@description('Every database the knowledge server holds, one per environment. Only where createKnowledgeServer is set.')
param knowledgeDatabaseNames array = [knowledgeDatabaseName]
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

@description('The knowledge server\'s own network, peered with each environment\'s.')
param knowledgeAddressPrefix string = '10.42.0.0/24'

@description('Resource ids of other environments\' networks that reach the knowledge server (test\'s, from prod). Empty strings are skipped.')
param knowledgeClientVnetIds array = []

@description('Other environments\' databases this environment\'s admin job sets up: { env, database, platformId, apiLogin, apiObjectId, workerLogin, workerObjectId }. Entries with an empty value are skipped.')
param knowledgeOtherSetups array = []

param logRetentionInDays int = 30
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

// The knowledge server (ADR 0042): one for test and prod, created where createKnowledgeServer is set.
// Each environment has its own API and worker identities and its own database on it; only the
// creating environment's admin identity administers it.
var knowledgeOn = knowledgeServerStage != 'none'
var knowledgeHere = knowledgeOn && createKnowledgeServer
var knowledgeServerName = '${namePrefix}-knowledge-${suffix}'
var knowledgeClients = filter(knowledgeClientVnetIds, id => !empty(id))

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

resource knowledgeAdminIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (knowledgeHere) {
  name: '${baseName}-knowledge-admin-id'
  location: location
  tags: allTags
}

module knowledgeNetwork 'modules/knowledge-network.bicep' = if (knowledgeHere) {
  name: 'knowledge-network'
  params: {
    name: '${namePrefix}-knowledge-vnet'
    location: location
    tags: allTags
    addressPrefix: knowledgeAddressPrefix
    serverName: knowledgeServerName
    clientVnetIds: concat([network.outputs.vnetId], knowledgeClients)
  }
}

// The other side of each peering, on this environment's network and on each client network.
module knowledgePeeringHere 'modules/peering.bicep' = if (knowledgeHere) {
  name: 'knowledge-peering-${environmentName}'
  params: {
    vnetName: '${baseName}-vnet'
    name: 'to-${namePrefix}-knowledge-vnet'
    remoteVnetId: knowledgeNetwork!.outputs.vnetId
  }
}

module knowledgePeeringClients 'modules/peering.bicep' = [for id in knowledgeClients: if (knowledgeHere) {
  name: 'knowledge-peering-${last(split(id, '/'))}'
  scope: resourceGroup(split(id, '/')[2], split(id, '/')[4])
  params: {
    vnetName: last(split(id, '/'))
    name: 'to-${namePrefix}-knowledge-vnet'
    remoteVnetId: knowledgeNetwork!.outputs.vnetId
  }
}]

module knowledgePostgres 'modules/postgres.bicep' = if (knowledgeHere) {
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
    databaseNames: knowledgeDatabaseNames
    delegatedSubnetId: knowledgeNetwork!.outputs.subnetId
    privateDnsZoneId: knowledgeNetwork!.outputs.dnsZoneId
    adminGroupObjectId: postgresAdminGroupObjectId
    adminGroupName: postgresAdminGroupName
    identityAdmins: [{ principalId: knowledgeAdminIdentity!.properties.principalId, name: knowledgeAdminIdentity!.name }]
    extensions: 'VECTOR,PG_PREWARM'
    sharedPreloadLibraries: 'pg_stat_statements,pg_prewarm'
  }
}

var knowledgeHost = knowledgeHere ? knowledgePostgres!.outputs.fqdn : knowledgePostgresHost

var knowledgeOwnSetup = knowledgeHere
  ? [
      {
        name: 'knowledge-setup'
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
        admin: true
      }
    ]
  : []

var knowledgeReadySetups = filter(knowledgeOtherSetups, s => !empty(s.platformId) && !empty(s.apiObjectId) && !empty(s.workerObjectId))

// Another environment's database: its platform server is out of reach, so its id comes from that environment's job.
var knowledgeOtherJobs = [for s in knowledgeReadySetups: {
  name: 'knowledge-setup-${s.env}'
  args: [
    '--principals'
    '--admin-user'
    '${baseName}-knowledge-admin-id'
    '--database'
    s.database
    '--platform-id'
    s.platformId
    '--api-login'
    s.apiLogin
    '--api-object-id'
    s.apiObjectId
    '--worker-login'
    s.workerLogin
    '--worker-object-id'
    s.workerObjectId
  ]
  admin: true
}]

// Elsewhere the job holds no knowledge identity: it prints the platform server's id for the creating environment's job.
var knowledgeJobs = !knowledgeOn
  ? []
  : knowledgeHere
      ? concat(knowledgeOwnSetup, knowledgeOtherJobs)
      : [{ name: 'knowledge-setup', args: ['--print-platform-id'], admin: false }]

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
    knowledgeJobs: knowledgeJobs
    knowledgeJobHost: knowledgeHost
    knowledgeAdmin: knowledgeHere
      ? { id: knowledgeAdminIdentity!.id, clientId: knowledgeAdminIdentity!.properties.clientId }
      : {}
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    cpu: cpu
    memory: memory
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
output knowledgeJobNames array = apps.outputs.knowledgeJobNames
output vnetId string = network.outputs.vnetId
