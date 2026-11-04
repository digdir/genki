param name string
param location string
param tags object
param version string
param skuName string
param skuTier string
param storageSizeGB int
param backupRetentionDays int
param geoRedundantBackup string
param highAvailability string

@description('The databases to create; outputs name the first.')
param databaseNames array
param delegatedSubnetId string
param privateDnsZoneId string
param adminGroupObjectId string
param adminGroupName string

@description('Managed identities that are Entra admins beside the group: { principalId, name }.')
param identityAdmins array = []

@description('The azure.extensions allowlist, comma separated.')
param extensions string = 'VECTOR'

@description('shared_preload_libraries; empty leaves the server default. Static: it takes effect after a restart.')
param sharedPreloadLibraries string = ''

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: name
  location: location
  tags: tags
  sku: { name: skuName, tier: skuTier }
  properties: {
    version: version
    storage: { storageSizeGB: storageSizeGB, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: backupRetentionDays, geoRedundantBackup: geoRedundantBackup }
    highAvailability: { mode: highAvailability }
    network: {
      delegatedSubnetResourceId: delegatedSubnetId
      privateDnsZoneArmResourceId: privateDnsZoneId
      publicNetworkAccess: 'Disabled'
    }
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: subscription().tenantId
    }
  }
}

resource extensionsConfig 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'azure.extensions'
  properties: { value: extensions, source: 'user-override' }
}

resource preload 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = if (!empty(sharedPreloadLibraries)) {
  parent: server
  name: 'shared_preload_libraries'
  properties: { value: sharedPreloadLibraries, source: 'user-override' }
  dependsOn: [extensionsConfig]
}

@batchSize(1)
resource databases 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = [for database in databaseNames: {
  parent: server
  name: database
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
  dependsOn: [extensionsConfig, preload]
}]

resource groupAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: server
  name: adminGroupObjectId
  properties: {
    principalType: 'Group'
    principalName: adminGroupName
    tenantId: subscription().tenantId
  }
  dependsOn: [databases]
}

@batchSize(1)
resource admins 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = [for admin in identityAdmins: {
  parent: server
  name: admin.principalId
  properties: {
    principalType: 'ServicePrincipal'
    principalName: admin.name
    tenantId: subscription().tenantId
  }
  dependsOn: [groupAdmin]
}]

output name string = server.name
output fqdn string = server.properties.fullyQualifiedDomainName
output databaseName string = databaseNames[0]
