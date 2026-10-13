param name string
param location string
param tags object
param shareName string = 'data'
param shareQuotaGB int = 100

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

output name string = account.name
output shareName string = share.name
