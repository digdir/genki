param name string
param location string
param tags object
param registryName string
param workerImage string
param identityId string
param identityClientId string
param identityPrincipalId string
param apiUrl string
param audience string
param dnsZoneName string
param reservedHostnames array
param actionGroupId string = ''
param mailWrites bool = true

var acrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource environment 'Microsoft.App/managedEnvironments@2025-02-02-preview' existing = {
  name: '${name}-hosted-env'
}

resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, identityId, acrPull)
  properties: {
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPull)
  }
}

resource job 'Microsoft.App/jobs@2025-02-02-preview' = {
  name: '${name}-hostname-binder'
  location: location
  tags: tags
  dependsOn: [pull]
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityId}': {} }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: {
        cronExpression: '* * * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaTimeout: 55
      replicaRetryLimit: 0
      registries: [{ server: registry.properties.loginServer, identity: identityId }]
      secrets: []
    }
    template: {
      containers: [
        {
          name: 'binder'
          image: workerImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          command: ['node', 'scripts/hostname-binder.ts']
          env: [
            { name: 'AZURE_CLIENT_ID', value: identityClientId }
            { name: 'GENAI_API_URL', value: apiUrl }
            { name: 'HOSTNAME_BINDER_AUDIENCE', value: audience }
            { name: 'AZURE_SUBSCRIPTION_ID', value: subscription().subscriptionId }
            { name: 'AZURE_RESOURCE_GROUP', value: resourceGroup().name }
            { name: 'HOST_APP_NAME', value: '${name}-assistant' }
            { name: 'HOST_ENVIRONMENT_NAME', value: environment.name }
            { name: 'DNS_ZONE_NAME', value: dnsZoneName }
            { name: 'HOSTNAME_BINDER_RESERVED', value: join(reservedHostnames, ',') }
          ]
        }
      ]
    }
  }
}

resource writes 'Microsoft.Insights/activityLogAlerts@2023-01-01-preview' = if (!empty(actionGroupId)) {
  name: '${name}-hostname-binder-writes'
  location: 'global'
  tags: tags
  properties: {
    description: 'The hostname binder wrote to Azure: a binding, a certificate or a DNS record. Check it against the claims (docs/runbook.md, "Hostname binder").'
    enabled: true
    scopes: [resourceGroup().id]
    condition: {
      allOf: [
        { field: 'category', equals: 'Administrative' }
        {
          anyOf: [
            { field: 'caller', equals: identityClientId }
            { field: 'caller', equals: identityPrincipalId }
          ]
        }
      ]
    }
    actions: { actionGroups: mailWrites ? [{ actionGroupId: actionGroupId }] : [] }
  }
}

resource denied 'Microsoft.Insights/activityLogAlerts@2023-01-01-preview' = if (!empty(actionGroupId)) {
  name: '${name}-hostname-fence'
  location: 'global'
  tags: tags
  properties: {
    description: 'Azure Policy refused a write in this resource group, such as one outside the assistant host\'s fence (docs/runbook.md, "Hostname binder").'
    enabled: true
    scopes: [resourceGroup().id]
    condition: {
      allOf: [
        { field: 'category', equals: 'Policy' }
        { field: 'operationName', equals: 'Microsoft.Authorization/policies/deny/action' }
      ]
    }
    actions: { actionGroups: [{ actionGroupId: actionGroupId }] }
  }
}

output jobName string = job.name
