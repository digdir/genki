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
param databaseName string
param delegatedSubnetId string
param privateDnsZoneId string
param adminGroupObjectId string
param adminGroupName string
param appIdentityPrincipalId string
param appIdentityName string
param appIdentityIsAdmin bool

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

resource extensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'azure.extensions'
  properties: { value: 'VECTOR', source: 'user-override' }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: databaseName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
  dependsOn: [extensions]
}

resource groupAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: server
  name: adminGroupObjectId
  properties: {
    principalType: 'Group'
    principalName: adminGroupName
    tenantId: subscription().tenantId
  }
  dependsOn: [database]
}

resource appAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = if (appIdentityIsAdmin) {
  parent: server
  name: appIdentityPrincipalId
  properties: {
    principalType: 'ServicePrincipal'
    principalName: appIdentityName
    tenantId: subscription().tenantId
  }
  dependsOn: [groupAdmin]
}

output name string = server.name
output fqdn string = server.properties.fullyQualifiedDomainName
output databaseName string = database.name
