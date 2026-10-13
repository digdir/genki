param name string
param environmentName string
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
param apiImage string
param workerImage string
param appsImage string
param appVersion string
param appEnv object
param identityEnv object
param webSettings object
param postgresHost string
param postgresDatabase string
param storageAccountName string
param storageShareName string

@description('Custom hostnames per app: api, portal, workspace, console. Empty strings are skipped.')
param hostnames object

@allowed(['none', 'hostnames', 'certificates'])
param customDomainsStage string
param minReplicas int
param maxReplicas int
param cpu string
param memory string

resource insights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: insightsName
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
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

resource dataStorage 'Microsoft.App/managedEnvironments/storages@2025-02-02-preview' = {
  parent: environment
  name: 'data'
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: storageShareName
      accessMode: 'ReadWrite'
    }
  }
}

var appNames = ['api', 'portal', 'workspace', 'console']
var withHost = filter(appNames, app => !empty(hostnames[app]))

resource certificates 'Microsoft.App/managedEnvironments/managedCertificates@2025-02-02-preview' = [for app in withHost: if (customDomainsStage == 'certificates') {
  parent: environment
  name: replace(hostnames[app], '.', '-')
  location: location
  tags: tags
  properties: {
    subjectName: hostnames[app]
    domainControlValidation: 'CNAME'
  }
}]

var customDomains = toObject(appNames, app => app, app => empty(hostnames[app]) || customDomainsStage == 'none'
  ? []
  : [
      {
        name: hostnames[app]
        bindingType: customDomainsStage == 'certificates' ? 'SniEnabled' : 'Disabled'
        certificateId: customDomainsStage == 'certificates'
          ? resourceId('Microsoft.App/managedEnvironments/managedCertificates', environment.name, replace(hostnames[app], '.', '-'))
          : null
      }
    ])

var secretEnv = [for secret in keyVaultSecretNames: {
  name: toUpper(replace(replace(secret, '-', '_'), '.', '_'))
  secretRef: secret
}]

var secrets = [for secret in keyVaultSecretNames: {
  name: secret
  keyVaultUrl: '${keyVaultUri}secrets/${secret}'
  identity: identityId
}]

var plainEnv = filter(map(items(appEnv), item => { name: item.key, value: string(item.value) }), pair => !empty(pair.value))
var identityPlainEnv = filter(map(items(identityEnv), item => { name: item.key, value: string(item.value) }), pair => !empty(pair.value))

var serverEnv = concat(
  [
    { name: 'APP_VERSION', value: appVersion }
    { name: 'GENAI_ENV', value: environmentName }
    { name: 'AZURE_CLIENT_ID', value: identityClientId }
    { name: 'PGHOST', value: postgresHost }
    { name: 'PGDATABASE', value: postgresDatabase }
    { name: 'PGUSER', value: identityName }
    { name: 'PGSSLMODE', value: 'require' }
    { name: 'DATA_DIR', value: '/data' }
    { name: 'BLOB_DIR', value: '/data/blobs' }
  ],
  identityPlainEnv,
  secretEnv,
  plainEnv
)

var dataVolume = [{ name: 'data', storageType: 'AzureFile', storageName: dataStorage.name }]
var dataMount = [{ volumeName: 'data', mountPath: '/data' }]

resource api 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: '${name}-api'
  location: location
  tags: tags
  dependsOn: [certificates]
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
        customDomains: customDomains.api
      }
      registries: [{ server: registryServer, identity: identityId }]
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: 'api'
          image: apiImage
          resources: { cpu: json(cpu), memory: memory }
          env: concat([{ name: 'PORT', value: '8080' }], serverEnv)
          volumeMounts: dataMount
          probes: [
            { type: 'Liveness', httpGet: { path: '/health', port: 8080 }, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/health', port: 8080 }, periodSeconds: 10 }
          ]
        }
      ]
      volumes: dataVolume
      scale: { minReplicas: minReplicas, maxReplicas: maxReplicas }
    }
  }
}

resource worker 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: '${name}-worker'
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
      registries: [{ server: registryServer, identity: identityId }]
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: workerImage
          resources: { cpu: json(cpu), memory: memory }
          env: serverEnv
          volumeMounts: dataMount
        }
      ]
      volumes: dataVolume
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

var apiPublicUrl = empty(hostnames.api) ? 'https://${api.properties.configuration.ingress.fqdn}' : 'https://${hostnames.api}'
var portalUrl = empty(hostnames.portal) ? '' : 'https://${hostnames.portal}'

var webApps = [
  {
    app: 'portal'
    env: {
      ANSATTPORTEN_ISSUER: webSettings.ansattportenIssuer
      OIDC_CLIENT_ID: webSettings.portalClientId
    }
  }
  {
    app: 'workspace'
    env: {
      ANSATTPORTEN_ISSUER: webSettings.ansattportenIssuer
      OIDC_CLIENT_ID: webSettings.workspaceClientId
      PORTAL_URL: portalUrl
    }
  }
  {
    app: 'console'
    env: {
      OIDC_ISSUER: webSettings.consoleIssuer
      OIDC_CLIENT_ID: webSettings.consoleClientId
      OIDC_TOKEN_ENDPOINT: webSettings.consoleTokenEndpoint
      ENVIRONMENT: environmentName
    }
  }
]

resource web 'Microsoft.App/containerApps@2025-02-02-preview' = [for item in webApps: {
  name: '${name}-${item.app}'
  location: location
  tags: tags
  dependsOn: [certificates]
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
        customDomains: customDomains[item.app]
      }
      registries: [{ server: registryServer, identity: identityId }]
    }
    template: {
      containers: [
        {
          name: item.app
          image: appsImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: filter(
            concat(
              [
                { name: 'APP', value: item.app }
                { name: 'API_UPSTREAM', value: 'https://${api.properties.configuration.ingress.fqdn}' }
                { name: 'PUBLIC_API_BASE', value: apiPublicUrl }
                { name: 'API_AUDIENCE', value: webSettings.apiAudience }
                { name: 'ALTINN_RESOURCE', value: webSettings.altinnResource }
              ],
              map(items(item.env), pair => { name: pair.key, value: string(pair.value) })
            ),
            pair => !empty(pair.value)
          )
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 10 }
          ]
        }
      ]
      scale: { minReplicas: minReplicas, maxReplicas: maxReplicas }
    }
  }
}]

output environmentName string = environment.name
output verificationId string = environment.properties.customDomainConfiguration.customDomainVerificationId
output appName string = api.name
output workerName string = worker.name
output webAppNames array = [for (item, i) in webApps: web[i].name]
output fqdn string = api.properties.configuration.ingress.fqdn
output defaultFqdns object = {
  api: api.properties.configuration.ingress.fqdn
  portal: web[0].properties.configuration.ingress.fqdn
  workspace: web[1].properties.configuration.ingress.fqdn
  console: web[2].properties.configuration.ingress.fqdn
}
