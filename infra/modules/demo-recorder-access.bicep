param baseName string
param roleDefinitionId string

resource api 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${baseName}-api-id'
}

resource job 'Microsoft.App/jobs@2025-02-02-preview' existing = {
  name: '${baseName}-demo-recorder'
}

resource onJob 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: job
  name: guid(job.id, api.id, roleDefinitionId)
  properties: {
    principalId: api.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleDefinitionId
  }
}
