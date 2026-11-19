param name string
param location string
param tags object
param workspaceId string
param registryName string
param keyVaultPublicNetworkAccess string = 'Enabled'

var acrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${name}-assistant-id'
  location: location
  tags: tags
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, identity.id, acrPull)
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPull)
  }
}

module hostVault 'keyvault.bicep' = {
  name: 'assistant-host-vault'
  params: {
    name: take('${name}-hostkv', 24)
    location: location
    tags: tags
    readerPrincipalId: identity.properties.principalId
    publicNetworkAccess: keyVaultPublicNetworkAccess
  }
}

resource environment 'Microsoft.App/managedEnvironments@2025-02-02-preview' = {
  name: '${name}-hosted-env'
  location: location
  tags: tags
  properties: {
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    appLogsConfiguration: { destination: 'azure-monitor' }
  }
}

resource environmentLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: environment
  name: 'logs'
  properties: {
    workspaceId: workspaceId
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
  }
}

output identityName string = identity.name
output vaultName string = hostVault.outputs.name
