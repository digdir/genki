param name string
param location string
param tags object
param appsSubnetId string
param workspaceId string
param insightsName string
param identityId string
param identityClientId string
param identityName string
param registryServer string
param keyVaultUri string
param keyVaultSecretNames array
param image string
param appVersion string
param appEnv object
param postgresHost string
param postgresDatabase string
param minReplicas int
param maxReplicas int
param cpu string
param memory string

resource insights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: insightsName
}

resource environment 'Microsoft.App/managedEnvironments@2025-02-02-preview' = {
  name: '${name}-env'
  location: location
  tags: tags
  properties: {
    vnetConfiguration: {
      infrastructureSubnetId: appsSubnetId
      internal: false
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    appLogsConfiguration: { destination: 'azure-monitor' }
    appInsightsConfiguration: { connectionString: insights.properties.ConnectionString }
    openTelemetryConfiguration: {
      tracesConfiguration: { destinations: ['appInsights'] }
      logsConfiguration: { destinations: ['appInsights'] }
    }
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

var secretEnv = [for secret in keyVaultSecretNames: {
  name: toUpper(replace(replace(secret, '-', '_'), '.', '_'))
  secretRef: secret
}]

var plainEnv = [for item in items(appEnv): { name: item.key, value: string(item.value) }]

resource api 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: '${name}-api'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityId}': {} }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      registries: [{ server: registryServer, identity: identityId }]
      secrets: [for secret in keyVaultSecretNames: {
        name: secret
        keyVaultUrl: '${keyVaultUri}secrets/${secret}'
        identity: identityId
      }]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: image
          resources: { cpu: json(cpu), memory: memory }
          env: concat(
            [
              { name: 'PORT', value: '8080' }
              { name: 'APP_VERSION', value: appVersion }
              { name: 'AZURE_CLIENT_ID', value: identityClientId }
              { name: 'PGHOST', value: postgresHost }
              { name: 'PGDATABASE', value: postgresDatabase }
              { name: 'PGUSER', value: identityName }
              { name: 'PGSSLMODE', value: 'require' }
            ],
            secretEnv,
            plainEnv
          )
          probes: [
            { type: 'Liveness', httpGet: { path: '/health', port: 8080 }, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/health', port: 8080 }, periodSeconds: 10 }
          ]
        }
      ]
      scale: { minReplicas: minReplicas, maxReplicas: maxReplicas }
    }
  }
}

output environmentName string = environment.name
output appName string = api.name
output fqdn string = api.properties.configuration.ingress.fqdn
