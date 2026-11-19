param name string
param location string
param tags object
param registryName string
param appsImage string
param apiUpstream string
@description('The issuer the browser logs in with, which the host\'s CSP lets it reach.')
param ansattportenIssuer string = ''
@description('genki\'s own assistant hostname, bound as the other apps\' hostnames are.')
param hostname string = ''
@allowed(['none', 'hostnames', 'certificates'])
param customDomainsStage string = 'none'
param minReplicas int = 1
param maxReplicas int = 3

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${name}-assistant-id'
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource environment 'Microsoft.App/managedEnvironments@2025-02-02-preview' existing = {
  name: '${name}-hosted-env'
}

var bound = !empty(hostname) && customDomainsStage != 'none'
var certificateName = replace(hostname, '.', '-')

resource certificate 'Microsoft.App/managedEnvironments/managedCertificates@2025-02-02-preview' = if (bound && customDomainsStage == 'certificates') {
  parent: environment
  name: certificateName
  location: location
  tags: tags
  properties: {
    subjectName: hostname
    domainControlValidation: 'CNAME'
  }
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
        customDomains: bound
          ? [
              {
                name: hostname
                bindingType: customDomainsStage == 'certificates' ? 'SniEnabled' : 'Disabled'
                certificateId: customDomainsStage == 'certificates' ? certificate.id : null
              }
            ]
          : []
      }
      registries: [{ server: registry.properties.loginServer, identity: identity.id }]
    }
    template: {
      containers: [
        {
          name: 'assistant'
          image: appsImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'APP', value: 'assistant' }
            { name: 'API_UPSTREAM', value: apiUpstream }
            { name: 'ANSATTPORTEN_ISSUER', value: ansattportenIssuer }
          ]
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
