param name string
param location string
param tags object
param shareName string = 'data'
param shareQuotaGB int = 100
@description('Principal that may read and write the conversions container (the knowledge worker identity); empty for none.')
param conversionsWriterPrincipalId string = ''
param conversionsContainerName string = 'conversions'

var blobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
  }
}

resource files 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: account
  name: 'default'
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: files
  name: shareName
  properties: {
    shareQuota: shareQuotaGB
    enabledProtocols: 'SMB'
  }
}

// Converters' native output (ADR 0042), keyed by file sha256 with no tenant. Overwritten and deleted
// blobs stay as earlier versions until 30 days after that version was written, not after it was replaced.
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: account
  name: 'default'
  properties: {
    isVersioningEnabled: true
    // Off: a withdrawal must erase a file's earlier versions at once (ADR 0042).
    deleteRetentionPolicy: { enabled: false }
  }
}

resource conversions 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: conversionsContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: account
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'conversions-earlier-versions'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['${conversionsContainerName}/'] }
            actions: { version: { delete: { daysAfterCreationGreaterThan: 30 } } }
          }
        }
      ]
    }
  }
}

resource conversionsWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(conversionsWriterPrincipalId)) {
  scope: conversions
  name: guid(conversions.id, conversionsWriterPrincipalId, blobDataContributor)
  properties: {
    principalId: conversionsWriterPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributor)
  }
}

output name string = account.name
output shareName string = share.name
output conversionsUrl string = '${account.properties.primaryEndpoints.blob}${conversions.name}'
