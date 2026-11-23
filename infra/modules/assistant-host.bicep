param name string
param location string
param tags object
param registryName string
param appsImage string
param apiUpstream string
@description('The issuer the browser logs in with, which the host\'s CSP lets it reach.')
param ansattportenIssuer string = ''
param minReplicas int = 1
param maxReplicas int = 3
@description('Reads genai-proxy-key from the host\'s own Key Vault and turns on the BFF routes (ADR 0061).')
param bffProxyKey bool = false

@description('{ hostname, tenant, stage, apex? } from main.bicep\'s hostedHostnames.')
param hostedHostnames array = []

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${name}-assistant-id'
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource hostVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: take('${name}-hostkv', 24)
}

resource environment 'Microsoft.App/managedEnvironments@2025-07-01' existing = {
  name: '${name}-hosted-env'
}

var bound = filter(hostedHostnames, h => h.stage != 'none')
var certified = filter(bound, h => h.stage == 'certificates')
var certificateName = toObject(hostedHostnames, h => toLower(h.hostname), h => replace(toLower(h.hostname), '.', '-'))

resource certificates 'Microsoft.App/managedEnvironments/managedCertificates@2025-07-01' = [for h in certified: {
  parent: environment
  name: certificateName[toLower(h.hostname)]
  location: location
  tags: tags
  properties: {
    subjectName: toLower(h.hostname)
    domainControlValidation: h.?apex ?? false ? 'HTTP' : 'CNAME'
  }
}]

resource host 'Microsoft.App/containerApps@2025-07-01' = {
  name: '${name}-assistant'
  location: location
  tags: tags
  dependsOn: [certificates]
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
        customDomains: map(bound, h => {
          name: toLower(h.hostname)
          bindingType: h.stage == 'certificates' ? 'SniEnabled' : 'Disabled'
          certificateId: h.stage == 'certificates'
            ? resourceId('Microsoft.App/managedEnvironments/managedCertificates', environment.name, certificateName[toLower(h.hostname)])
            : null
        })
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
              { name: 'ANSATTPORTEN_ISSUER', value: ansattportenIssuer }
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

@description('The records each hosted hostname needs in its own DNS before its stage moves past none.')
output dnsRecords array = map(hostedHostnames, h => {
  hostname: toLower(h.hostname)
  records: [
    h.?apex ?? false
      ? { type: 'A', name: toLower(h.hostname), value: environment.properties.staticIp }
      : { type: 'CNAME', name: toLower(h.hostname), value: host.properties.configuration.ingress.fqdn }
    {
      type: 'TXT'
      name: 'asuid.${toLower(h.hostname)}'
      value: environment.properties.customDomainConfiguration.customDomainVerificationId
    }
  ]
})
