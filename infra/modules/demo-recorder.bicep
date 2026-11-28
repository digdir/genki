param name string
param location string
param tags object
param registryName string
param vaultName string
param recorderImage string
param identityId string
param identityClientId string
param identityPrincipalId string
param apiUrl string
param portalUrl string
param consoleUrl string
param audience string
param settings object

var acrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var secretsUser = '4633458b-17de-408a-b874-0445c86b69e6'
var elevenLabsSecret = settings.?elevenLabsKeySecret ?? ''
var signInSecret = settings.?signInKeySecret ?? ''
var secretNames = filter([elevenLabsSecret, signInSecret], s => !empty(s))

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: vaultName
}

resource secrets 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = [for secret in secretNames: {
  parent: vault
  name: secret
}]

resource environment 'Microsoft.App/managedEnvironments@2025-02-02-preview' existing = {
  name: '${name}-env'
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

resource reads 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (secret, i) in secretNames: {
  scope: secrets[i]
  name: guid(vault.id, secret, identityId, secretsUser)
  properties: {
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUser)
  }
}]

var vaultUri = vault.properties.vaultUri

var plainEnv = [
  { name: 'AZURE_CLIENT_ID', value: identityClientId }
  { name: 'DEMO_API_URL', value: apiUrl }
  { name: 'DEMO_PORTAL_URL', value: portalUrl }
  { name: 'DEMO_CONSOLE_URL', value: consoleUrl }
  { name: 'DEMO_RECORDER_AUDIENCE', value: audience }
  { name: 'DEMO_ELEVENLABS_KEY_SECRET', value: empty(elevenLabsSecret) ? '' : '${vaultUri}secrets/${elevenLabsSecret}' }
  { name: 'DEMO_API_KEY_SECRET', value: empty(signInSecret) ? '' : '${vaultUri}secrets/${signInSecret}' }
  { name: 'SPEECH_ENDPOINT', value: settings.?speechEndpoint ?? '' }
  { name: 'DEMO_AUDIO_ENDPOINT', value: settings.?audioEndpoint ?? '' }
  { name: 'DEMO_DIRECTOR_MODEL', value: settings.?directorModel ?? '' }
  { name: 'CI', value: 'true' }
]

resource job 'Microsoft.App/jobs@2025-02-02-preview' = {
  name: '${name}-demo-recorder'
  location: location
  tags: tags
  dependsOn: [pull, reads]
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityId}': {} }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      replicaTimeout: 3600
      replicaRetryLimit: 0
      registries: [{ server: registry.properties.loginServer, identity: identityId }]
      secrets: []
    }
    template: {
      containers: [
        {
          name: 'recorder'
          image: recorderImage
          resources: { cpu: json('2'), memory: '4Gi' }
          env: filter(plainEnv, pair => !empty(pair.value))
        }
      ]
    }
  }
}

output jobName string = job.name
output jobId string = job.id
