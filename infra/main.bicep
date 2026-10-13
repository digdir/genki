targetScope = 'resourceGroup'

@allowed(['test', 'prod'])
param environmentName string
param namePrefix string = 'genai'
param location string = resourceGroup().location
param tags object = {}

@description('Container image by digest, e.g. <registry>.azurecr.io/genai-api@sha256:...')
param image string = 'mcr.microsoft.com/k8se/quickstart:latest'
param appVersion string = 'bootstrap'
param appEnv object = {}

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

module apps 'modules/containerapps.bicep' = {
  name: 'containerapps'
  params: {
    name: baseName
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
    image: image
    appVersion: appVersion
    appEnv: appEnv
    postgresHost: postgres.outputs.fqdn
    postgresDatabase: postgres.outputs.databaseName
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    cpu: cpu
    memory: memory
  }
}

output apiUrl string = 'https://${apps.outputs.fqdn}'
output containerAppName string = apps.outputs.appName
output registryName string = registry.outputs.name
output registryLoginServer string = registry.outputs.loginServer
output keyVaultName string = vault.outputs.name
output postgresHost string = postgres.outputs.fqdn
output appIdentityClientId string = appIdentity.properties.clientId
output appIdentityName string = appIdentity.name
