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

param addressPrefix string = '10.40.0.0/16'
param appsSubnetPrefix string = '10.40.0.0/23'
param postgresSubnetPrefix string = '10.40.2.0/24'

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
    databaseName: 'genai'
    delegatedSubnetId: network.outputs.postgresSubnetId
    privateDnsZoneId: network.outputs.postgresDnsZoneId
    adminGroupObjectId: postgresAdminGroupObjectId
    adminGroupName: postgresAdminGroupName
    appIdentityPrincipalId: appIdentity.properties.principalId
    appIdentityName: appIdentity.name
    appIdentityIsAdmin: appIdentityIsPostgresAdmin
  }
}

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
    postgresHost: postgres.outputs.fqdn
    postgresDatabase: postgres.outputs.databaseName
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
