param baseName string
param namePrefix string
param environmentName string
param dnsZoneName string
param roleDefinitionId string
param hostFenceId string
param recordFenceId string
param policyEffect string

var registryName = take('${namePrefix}${environmentName}${uniqueString(resourceGroup().id)}', 50)

resource binder 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${baseName}-binder-id'
}

resource hostIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${baseName}-assistant-id'
}

resource host 'Microsoft.App/containerApps@2025-02-02-preview' existing = {
  name: '${baseName}-assistant'
}

resource hostEnvironment 'Microsoft.App/managedEnvironments@2025-02-02-preview' existing = {
  name: '${baseName}-hosted-env'
}

resource appsZone 'Microsoft.Network/dnsZones@2018-05-01' existing = {
  name: 'apps.${dnsZoneName}'
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource hostVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: take('${baseName}-hostkv', 24)
}

var assignment = {
  principalId: binder.properties.principalId
  principalType: 'ServicePrincipal'
  roleDefinitionId: roleDefinitionId
}

resource onHost 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: host
  name: guid(host.id, binder.id, roleDefinitionId)
  properties: assignment
}

resource onEnvironment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: hostEnvironment
  name: guid(hostEnvironment.id, binder.id, roleDefinitionId)
  properties: assignment
}

resource onZone 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: appsZone
  name: guid(appsZone.id, binder.id, roleDefinitionId)
  properties: assignment
}

resource onHostIdentity 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: hostIdentity
  name: guid(hostIdentity.id, binder.id, roleDefinitionId)
  properties: assignment
}

var hostEnv = host.properties.template.containers[0].env

resource hostFence 'Microsoft.Authorization/policyAssignments@2024-04-01' = {
  name: '${baseName}-assistant-host-fence'
  properties: {
    displayName: 'genki assistant host fence (${baseName})'
    policyDefinitionId: hostFenceId
    parameters: {
      effect: { value: policyEffect }
      appName: { value: host.name }
      loginServer: { value: registry.properties.loginServer }
      identityId: { value: hostIdentity.id }
      proxyKeyUrl: { value: '${hostVault.properties.vaultUri}secrets/genai-proxy-key' }
      apiUpstream: { value: filter(hostEnv, e => e.name == 'API_UPSTREAM')[0].value }
      issuer: { value: filter(hostEnv, e => e.name == 'ANSATTPORTEN_ISSUER')[0].value }
    }
  }
}

resource recordFence 'Microsoft.Authorization/policyAssignments@2024-04-01' = {
  name: '${baseName}-apps-zone-fence'
  properties: {
    displayName: 'genki apps zone fence (${baseName})'
    policyDefinitionId: recordFenceId
    parameters: {
      effect: { value: policyEffect }
      zoneName: { value: appsZone.name }
      target: { value: host.properties.configuration.ingress.fqdn }
      verificationId: { value: hostEnvironment.properties.customDomainConfiguration.customDomainVerificationId }
    }
  }
}
