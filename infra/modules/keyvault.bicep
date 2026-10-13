param name string
param location string
param tags object
param readerPrincipalId string
param publicNetworkAccess string

var secretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: publicNetworkAccess
    networkAcls: { defaultAction: 'Allow', bypass: 'AzureServices' }
  }
}

resource reader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, readerPrincipalId, secretsUser)
  properties: {
    principalId: readerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUser)
  }
}

output name string = vault.name
output uri string = vault.properties.vaultUri
output readerRoleId string = reader.id
