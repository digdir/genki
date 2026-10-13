param name string
param location string
param tags object
param pullPrincipalId string
param pushPrincipalId string = ''

var acrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var acrPush = '8311e382-0749-4cb8-b61a-304f252e45ec'

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: name
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, pullPrincipalId, acrPull)
  properties: {
    principalId: pullPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPull)
  }
}

resource push 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(pushPrincipalId)) {
  scope: registry
  name: guid(registry.id, pushPrincipalId, acrPush)
  properties: {
    principalId: pushPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPush)
  }
}

output name string = registry.name
output loginServer string = registry.properties.loginServer
output pullRoleId string = pull.id
