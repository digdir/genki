param name string
param location string
param tags object

@description('The backup identity: may write blobs in the container, and nothing else on the account.')
param writerPrincipalId string

@description('The network the dump job runs in, and its subnet for private endpoints; the account takes no other traffic.')
param vnetId string
param endpointsSubnetId string

@description('true once the immutability policy is locked by hand (docs/runbook.md, "Backups"): Azure refuses to change a locked policy, so the template leaves it alone.')
param immutabilityLocked bool = false

@description('Days each copy can be neither changed nor deleted, by anyone; it is deleted a day later.')
param retentionDays int = 84
param containerName string = 'platform'

var blobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    accessTier: 'Cool'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'None' }
  }
}

resource blobDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'privatelink.blob.${environment().suffixes.storage}'
  location: 'global'
  tags: tags
}

resource blobDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: blobDns
  name: '${name}-link'
  location: 'global'
  tags: tags
  properties: { registrationEnabled: false, virtualNetwork: { id: vnetId } }
}

resource endpoint 'Microsoft.Network/privateEndpoints@2024-10-01' = {
  name: '${name}-blob'
  location: location
  tags: tags
  properties: {
    subnet: { id: endpointsSubnetId }
    privateLinkServiceConnections: [
      { name: 'blob', properties: { privateLinkServiceId: account.id, groupIds: ['blob'] } }
    ]
  }
}

resource endpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-10-01' = {
  parent: endpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [{ name: 'blob', properties: { privateDnsZoneId: blobDns.id } }]
  }
}

resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: account
  name: 'default'
  properties: {
    containerDeleteRetentionPolicy: { enabled: true, days: 14 }
  }
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: containerName
  properties: { publicAccess: 'None' }
}

resource worm 'Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies@2023-05-01' = if (!immutabilityLocked) {
  parent: container
  name: 'default'
  properties: {
    immutabilityPeriodSinceCreationInDays: retentionDays
    allowProtectedAppendWrites: false
  }
}

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: account
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expired-copies'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['${containerName}/'] }
            actions: { baseBlob: { delete: { daysAfterCreationGreaterThan: retentionDays + 1 } } }
          }
        }
      ]
    }
  }
}

resource writer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: container
  name: guid(container.id, writerPrincipalId, blobDataContributor)
  properties: {
    principalId: writerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributor)
  }
}

output id string = account.id
output containerUrl string = '${account.properties.primaryEndpoints.blob}${containerName}'
