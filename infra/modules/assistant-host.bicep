param name string
param location string
param tags object
param registryName string
param appsImage string
param apiUpstream string
param minReplicas int = 1
param maxReplicas int = 3
@description('Reads genai-proxy-key from the host\'s own Key Vault and turns on the BFF routes (ADR 0061).')
param bffProxyKey bool = false

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${name}-assistant-id'
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource hostVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: take('${name}-hostkv', 24)
}

resource environment 'Microsoft.App/managedEnvironments@2025-02-02-preview' existing = {
  name: '${name}-hosted-env'
}

resource host 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: '${name}-assistant'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
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
      registries: [{ server: registry.properties.loginServer, identity: identity.id }]
      secrets: bffProxyKey
        ? [{ name: 'genai-proxy-key', keyVaultUrl: '${hostVault.properties.vaultUri}secrets/genai-proxy-key', identity: identity.id }]
        : []
    }
    template: {
      containers: [
        {
          name: 'assistant'
          image: appsImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: concat(
            [
              { name: 'APP', value: 'assistant' }
              { name: 'API_UPSTREAM', value: apiUpstream }
            ],
            bffProxyKey ? [{ name: 'GENAI_PROXY_KEY', secretRef: 'genai-proxy-key' }] : []
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
}

output appName string = host.name
output fqdn string = host.properties.configuration.ingress.fqdn
output environmentName string = environment.name
output staticIp string = environment.properties.staticIp
output verificationId string = environment.properties.customDomainConfiguration.customDomainVerificationId
