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

@description('The Docling server image by digest (docker/docling).')
param doclingImage string

@description('Most Docling replicas at once; each converts one PDF at a time.')
param doclingMaxReplicas int = 8
param appVersion string
param appEnv object
param identityEnv object
param webSettings object
param postgresHost string
param postgresDatabase string

@description('The knowledge server for the API and worker: { host, database, vcores, api: { id, clientId, name }, worker: { id, clientId, name } }. Empty: none.')
param knowledge object = {}

@description('The principals job: { host, admin: { id, clientId }, args }, run in the worker image. Empty: none.')
param knowledgeSetup object = {}
param storageAccountName string
param storageShareName string

@description('Custom hostnames per app: api, portal, workspace, console. Empty strings are skipped.')
param hostnames object

@allowed(['none', 'hostnames', 'certificates'])
param customDomainsStage string

@description('Managed certificates that already exist in the environment, by app. Bound as they are instead of created.')
param existingCertificates object = {}
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

var certificateNames = toObject(appNames, app => app, app => existingCertificates[?app] ?? replace(hostnames[app], '.', '-'))

resource certificates 'Microsoft.App/managedEnvironments/managedCertificates@2025-02-02-preview' = [for app in withHost: if (customDomainsStage == 'certificates' && empty(existingCertificates[?app] ?? '')) {
  parent: environment
  name: certificateNames[app]
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
          ? resourceId('Microsoft.App/managedEnvironments/managedCertificates', environment.name, certificateNames[app])
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
    { name: 'INGEST_FOLDER_ROOT', value: '/app/genki-docs' }
  ],
  identityPlainEnv,
  secretEnv,
  plainEnv
)

var dataVolume = [{ name: 'data', storageType: 'AzureFile', storageName: dataStorage.name }]
var dataMount = [{ volumeName: 'data', mountPath: '/data' }]

// Each app logs in to the knowledge server as its own identity; the shared identity has no role there.
var knowledgeEnv = empty(knowledge)
  ? { api: [], worker: [] }
  : toObject(['api', 'worker'], app => app, app => concat(
      [
        { name: 'KNOWLEDGE_PGHOST', value: knowledge.host }
        { name: 'KNOWLEDGE_PGDATABASE', value: knowledge.database }
        { name: 'KNOWLEDGE_READ_PGHOST', value: knowledge.host }
        { name: 'KNOWLEDGE_PGUSER', value: knowledge[app].name }
        { name: 'KNOWLEDGE_AZURE_CLIENT_ID', value: knowledge[app].clientId }
      ],
      app == 'worker'
        ? [
            { name: 'KNOWLEDGE_VCORES', value: string(knowledge.vcores) }
            { name: 'CONVERSIONS_BLOB_URL', value: knowledge.conversionsUrl }
          ]
        : []
    ))
var knowledgeIdentity = toObject(['api', 'worker'], app => app, app => empty(knowledge) ? {} : { '${knowledge[app].id}': {} })

// The Docling server's key (ADR 0042): only the worker and the server get it, so the API and the web apps, which
// share the environment and could reach internal ingress, are refused. It is not in keyVaultSecretNames, which
// every server app gets.
var doclingKeySecret = {
  name: 'docling-api-key'
  keyVaultUrl: '${keyVaultUri}secrets/docling-api-key'
  identity: identityId
}

resource api 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: '${name}-api'
  location: location
  tags: tags
  dependsOn: [certificates]
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: union({ '${identityId}': {} }, knowledgeIdentity.api)
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
          env: concat([{ name: 'PORT', value: '8080' }], serverEnv, knowledgeEnv.api)
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
    userAssignedIdentities: union({ '${identityId}': {} }, knowledgeIdentity.worker)
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [{ server: registryServer, identity: identityId }]
      secrets: concat(secrets, [doclingKeySecret])
    }
    template: {
      containers: [
        union(
          {
            name: 'worker'
            image: workerImage
            resources: { cpu: json(cpu), memory: memory }
            env: concat(serverEnv, knowledgeEnv.worker, doclingEnv)
            volumeMounts: dataMount
          },
          // 503 until the worker has reached the knowledge server and found it bound to this platform server.
          empty(knowledge)
            ? {}
            : { probes: [{ type: 'Readiness', httpGet: { path: '/readyz', port: 8081 }, periodSeconds: 10 }] }
        )
      ]
      volumes: dataVolume
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

// The Docling server (ADR 0042, issue 476): PDF conversions for knowledge.convert. Internal TCP ingress, since
// HTTP ingress ends a request after 240 s and a conversion takes minutes; the worker holds one request open
// until Docling answers. One conversion per replica (one Docling worker on 4 vCPU), and replicas start on open
// connections, from zero. It keeps nothing past a replica: no volume, results dropped once fetched, OCR page images
// in /tmp deleted after each region, and WARNING logs, which still name the file and page when Tesseract fails on
// one. The platform identity is there only to pull the image and read the key: code in the container, which
// parses untrusted PDFs, cannot get a token for it.
resource docling 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: '${name}-docling'
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
        external: false
        transport: 'tcp'
        targetPort: 5001
        exposedPort: 5001
      }
      registries: [{ server: registryServer, identity: identityId }]
      secrets: [doclingKeySecret]
      identitySettings: [{ identity: identityId, lifecycle: 'None' }]
    }
    template: {
      containers: [
        {
          name: 'docling'
          image: doclingImage
          resources: { cpu: json('4'), memory: '8Gi' }
          env: [
            { name: 'DOCLING_SERVE_API_KEY', secretRef: doclingKeySecret.name }
            { name: 'DOCLING_SERVE_ENG_LOC_NUM_WORKERS', value: '1' }
            { name: 'DOCLING_NUM_THREADS', value: '4' }
            { name: 'OMP_NUM_THREADS', value: '4' }
            { name: 'DOCLING_SERVE_MAX_SYNC_WAIT', value: '3600' }
            { name: 'DOCLING_SERVE_SINGLE_USE_RESULTS', value: 'true' }
            { name: 'DOCLING_SERVE_RESULT_REMOVAL_DELAY', value: '1' }
            { name: 'DOCLING_SERVE_SCRATCH_PATH', value: '/tmp/docling' }
            { name: 'DOCLING_SERVE_LOG_LEVEL', value: 'WARNING' }
            { name: 'DOCLING_SERVE_ENABLE_UI', value: 'false' }
            { name: 'DOCLING_SERVE_ENABLE_API_DOCS', value: 'false' }
            { name: 'DOCLING_SERVE_SHOW_VERSION_INFO', value: 'false' }
            { name: 'DOCLING_SERVE_ENABLE_CAPABILITIES_ENDPOINT', value: 'false' }
            { name: 'DOCLING_SERVE_OTEL_ENABLE_METRICS', value: 'false' }
            { name: 'DOCLING_SERVE_OTEL_ENABLE_PROMETHEUS', value: 'false' }
          ]
          probes: [
            // 503 until the models are loaded
            { type: 'Startup', httpGet: { path: '/ready', port: 5001 }, periodSeconds: 10, failureThreshold: 30 }
            { type: 'Readiness', httpGet: { path: '/ready', port: 5001 }, periodSeconds: 10 }
            { type: 'Liveness', httpGet: { path: '/livez', port: 5001 }, periodSeconds: 30 }
          ]
        }
      ]
      // A replica stopped while it converts (scale-in, a new revision) gets the longest grace Container Apps allows
      terminationGracePeriodSeconds: 600
      scale: {
        minReplicas: 0
        maxReplicas: doclingMaxReplicas
        rules: [{ name: 'connections', tcp: { metadata: { concurrentConnections: '1' } } }]
      }
    }
  }
}

var doclingUrl = 'http://${docling.properties.configuration.ingress.fqdn}:5001'
var doclingEnv = [
  { name: 'DOCLING_URL', value: doclingUrl }
  { name: 'DOCLING_API_KEY', secretRef: doclingKeySecret.name }
]

// The principals job (ADR 0042): run by hand, inside the environment's network, the only place the
// knowledge server can be reached from. The platform side logs in as the app identity, the only one
// that can read the platform server's id; the knowledge side as the knowledge admin identity.
var platformTenantEnv = filter(identityPlainEnv, pair => pair.name == 'PLATFORM_TENANT')

// Azure evaluates a resource it does not deploy, so each read of knowledgeSetup sits behind `setupOn ?`.
var setupOn = !empty(knowledgeSetup)

resource knowledgeSetupJob 'Microsoft.App/jobs@2025-02-02-preview' = if (setupOn) {
  name: '${name}-knowledge-setup'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: union({ '${identityId}': {} }, setupOn ? { '${knowledgeSetup.admin.id}': {} } : {})
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      replicaTimeout: 600
      replicaRetryLimit: 0
      registries: [{ server: registryServer, identity: identityId }]
    }
    template: {
      containers: [
        {
          name: 'setup'
          image: workerImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          command: ['node', 'scripts/knowledge-server-setup.ts']
          args: setupOn ? knowledgeSetup.args : []
          env: concat(
            [
              { name: 'AZURE_CLIENT_ID', value: identityClientId }
              { name: 'PGHOST', value: postgresHost }
              { name: 'PGDATABASE', value: postgresDatabase }
              { name: 'PGUSER', value: identityName }
              { name: 'PGSSLMODE', value: 'require' }
            ],
            platformTenantEnv,
            setupOn
              ? [
                  { name: 'KNOWLEDGE_PGHOST', value: knowledgeSetup.host }
                  { name: 'KNOWLEDGE_ADMIN_AZURE_CLIENT_ID', value: knowledgeSetup.admin.clientId }
                ]
              : []
          )
        }
      ]
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
output doclingName string = docling.name
output knowledgeSetupJobName string = setupOn ? knowledgeSetupJob.name : ''
output fqdn string = api.properties.configuration.ingress.fqdn
output defaultFqdns object = {
  api: api.properties.configuration.ingress.fqdn
  portal: web[0].properties.configuration.ingress.fqdn
  workspace: web[1].properties.configuration.ingress.fqdn
  console: web[2].properties.configuration.ingress.fqdn
}
