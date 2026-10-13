param name string
param location string
param tags object
param version string
param skuName string
param skuTier string
param storageSizeGB int
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
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
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

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: databaseName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
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
