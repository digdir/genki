targetScope = 'subscription'

@allowed(['test', 'prod'])
param environmentName string
param namePrefix string = 'genai'
param resourceGroupName string

var baseName = '${namePrefix}-${environmentName}'
var groupScope = '${subscription().id}/resourceGroups/${resourceGroupName}'

var starterActions = ['Microsoft.App/jobs/start/action']

resource role 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, baseName, 'demo-recorder-starter')
  properties: {
    roleName: 'genki demo recorder starter (${baseName})'
    description: 'Starts ${baseName}-demo-recorder when a recording is queued, and nothing else (ADR 0059).'
    type: 'CustomRole'
    assignableScopes: [groupScope]
    permissions: [{ actions: starterActions, notActions: [], dataActions: [], notDataActions: [] }]
  }
}

module grant 'modules/demo-recorder-access.bicep' = {
  name: 'demo-recorder-access'
  scope: resourceGroup(resourceGroupName)
  params: {
    baseName: baseName
    roleDefinitionId: role.id
  }
}

output roleName string = role.properties.roleName
output starterActions array = starterActions
