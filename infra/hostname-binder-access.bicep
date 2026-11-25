targetScope = 'subscription'

@allowed(['test', 'prod'])
param environmentName string
param namePrefix string = 'genai'
param resourceGroupName string
param dnsZoneName string

@allowed(['Deny', 'Audit', 'Disabled'])
param policyEffect string = 'Deny'

var baseName = '${namePrefix}-${environmentName}'
var groupScope = '${subscription().id}/resourceGroups/${resourceGroupName}'

var binderActions = [
  'Microsoft.App/containerApps/read'
  'Microsoft.App/containerApps/write'
  'Microsoft.App/containerApps/listCustomHostNameAnalysis/action'
  'Microsoft.App/managedEnvironments/read'
  'Microsoft.App/managedEnvironments/join/action'
  'Microsoft.App/managedEnvironments/managedCertificates/read'
  'Microsoft.App/managedEnvironments/managedCertificates/write'
  'Microsoft.App/managedEnvironments/managedCertificates/delete'
  'Microsoft.ManagedIdentity/userAssignedIdentities/assign/action'
  'Microsoft.Network/dnsZones/CNAME/read'
  'Microsoft.Network/dnsZones/CNAME/write'
  'Microsoft.Network/dnsZones/CNAME/delete'
  'Microsoft.Network/dnsZones/TXT/read'
  'Microsoft.Network/dnsZones/TXT/write'
  'Microsoft.Network/dnsZones/TXT/delete'
]

resource role 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, baseName, 'hostname-binder')
  properties: {
    roleName: 'genki hostname binder (${baseName})'
    description: 'Binds hosted hostnames on ${baseName}-assistant and writes their records in apps.${dnsZoneName} (ADR 0062).'
    type: 'CustomRole'
    assignableScopes: [groupScope]
    permissions: [{ actions: binderActions, notActions: [], dataActions: [], notDataActions: [] }]
  }
}

var env = 'Microsoft.App/containerApps/template.containers[*].env[*]'

resource hostFence 'Microsoft.Authorization/policyDefinitions@2023-04-01' = {
  name: '${baseName}-assistant-host-fence'
  properties: {
    displayName: 'genki assistant host fence (${baseName})'
    description: 'Refuses a write to the assistant host app that changes its image, containers, env, secrets, registries, identity type, Dapr, volumes or ingress basics (ADR 0062).'
    policyType: 'Custom'
    mode: 'All'
    parameters: {
      effect: { type: 'String', allowedValues: ['Deny', 'Audit', 'Disabled'], defaultValue: 'Deny' }
      appName: { type: 'String' }
      loginServer: { type: 'String' }
      identityId: { type: 'String' }
      proxyKeyUrl: { type: 'String' }
      apiUpstream: { type: 'String' }
      issuer: { type: 'String' }
    }
    policyRule: {
      if: {
        allOf: [
          { field: 'type', equals: 'Microsoft.App/containerApps' }
          { field: 'name', equals: '[parameters(\'appName\')]' }
          {
            anyOf: [
              { count: { field: 'Microsoft.App/containerApps/template.containers[*]' }, notEquals: 1 }
              {
                count: {
                  field: 'Microsoft.App/containerApps/template.containers[*]'
                  where: { field: 'Microsoft.App/containerApps/template.containers[*].name', notEquals: 'assistant' }
                }
                greater: 0
              }
              {
                count: {
                  field: 'Microsoft.App/containerApps/template.containers[*]'
                  where: {
                    field: 'Microsoft.App/containerApps/template.containers[*].image'
                    notLike: '[concat(parameters(\'loginServer\'), \'/genai-apps@sha256:*\')]'
                  }
                }
                greater: 0
              }
              { count: { field: 'Microsoft.App/containerApps/template.containers[*].command[*]' }, greater: 0 }
              { count: { field: 'Microsoft.App/containerApps/template.containers[*].args[*]' }, greater: 0 }
              { count: { field: 'Microsoft.App/containerApps/template.containers[*].volumeMounts[*]' }, greater: 0 }
              {
                count: {
                  field: env
                  where: { field: '${env}.name', notIn: ['APP', 'API_UPSTREAM', 'ANSATTPORTEN_ISSUER', 'GENAI_PROXY_KEY'] }
                }
                greater: 0
              }
              {
                count: {
                  field: env
                  where: { allOf: [{ field: '${env}.name', equals: 'APP' }, { field: '${env}.value', notEquals: 'assistant' }] }
                }
                greater: 0
              }
              {
                count: {
                  field: env
                  where: {
                    allOf: [
                      { field: '${env}.name', equals: 'API_UPSTREAM' }
                      { field: '${env}.value', notEquals: '[parameters(\'apiUpstream\')]' }
                    ]
                  }
                }
                greater: 0
              }
              {
                count: {
                  field: env
                  where: {
                    allOf: [
                      { field: '${env}.name', equals: 'ANSATTPORTEN_ISSUER' }
                      { field: '${env}.value', notEquals: '[parameters(\'issuer\')]' }
                    ]
                  }
                }
                greater: 0
              }
              {
                count: {
                  field: env
                  where: {
                    allOf: [
                      { field: '${env}.name', equals: 'GENAI_PROXY_KEY' }
                      { field: '${env}.secretRef', notEquals: 'genai-proxy-key' }
                    ]
                  }
                }
                greater: 0
              }
              {
                count: {
                  field: env
                  where: {
                    allOf: [
                      { field: '${env}.name', notEquals: 'GENAI_PROXY_KEY' }
                      { field: '${env}.secretRef', exists: true }
                    ]
                  }
                }
                greater: 0
              }
              { count: { field: 'Microsoft.App/containerApps/template.initContainers[*]' }, greater: 0 }
              { count: { field: 'Microsoft.App/containerApps/template.volumes[*]' }, greater: 0 }
              { count: { field: 'Microsoft.App/containerApps/template.scale.rules[*]' }, greater: 0 }
              { count: { field: 'Microsoft.App/containerApps/template.serviceBinds[*]' }, greater: 0 }
              { field: 'Microsoft.App/containerApps/configuration.dapr.enabled', equals: true }
              { field: 'Microsoft.App/containerApps/configuration.ingress.allowInsecure', equals: true }
              { field: 'Microsoft.App/containerApps/configuration.ingress.external', notEquals: true }
              { field: 'Microsoft.App/containerApps/configuration.ingress.targetPort', notEquals: 8080 }
              {
                count: {
                  field: 'Microsoft.App/containerApps/configuration.secrets[*]'
                  where: {
                    anyOf: [
                      { field: 'Microsoft.App/containerApps/configuration.secrets[*].name', notEquals: 'genai-proxy-key' }
                      {
                        field: 'Microsoft.App/containerApps/configuration.secrets[*].keyVaultUrl'
                        notEquals: '[parameters(\'proxyKeyUrl\')]'
                      }
                      {
                        field: 'Microsoft.App/containerApps/configuration.secrets[*].identity'
                        notEquals: '[parameters(\'identityId\')]'
                      }
                    ]
                  }
                }
                greater: 0
              }
              {
                count: {
                  field: 'Microsoft.App/containerApps/configuration.registries[*]'
                  where: {
                    anyOf: [
                      {
                        field: 'Microsoft.App/containerApps/configuration.registries[*].server'
                        notEquals: '[parameters(\'loginServer\')]'
                      }
                      {
                        field: 'Microsoft.App/containerApps/configuration.registries[*].identity'
                        notEquals: '[parameters(\'identityId\')]'
                      }
                    ]
                  }
                }
                greater: 0
              }
              { field: 'identity.type', notEquals: 'UserAssigned' }
            ]
          }
        ]
      }
      then: { effect: '[parameters(\'effect\')]' }
    }
  }
}

resource recordFence 'Microsoft.Authorization/policyDefinitions@2023-04-01' = {
  name: '${baseName}-apps-zone-fence'
  properties: {
    displayName: 'genki apps zone fence (${baseName})'
    description: 'Refuses a record in genki\'s apps zone that does not point at the assistant host or carry its verification id (ADR 0062).'
    policyType: 'Custom'
    mode: 'All'
    parameters: {
      effect: { type: 'String', allowedValues: ['Deny', 'Audit', 'Disabled'], defaultValue: 'Deny' }
      zoneName: { type: 'String' }
      target: { type: 'String' }
      verificationId: { type: 'String' }
    }
    policyRule: {
      if: {
        allOf: [
          { field: 'fullName', like: '[concat(parameters(\'zoneName\'), \'/*\')]' }
          {
            anyOf: [
              {
                allOf: [
                  { field: 'type', equals: 'Microsoft.Network/dnszones/CNAME' }
                  {
                    anyOf: [
                      { field: 'Microsoft.Network/dnszones/CNAME/CNAMERecord.cname', notEquals: '[parameters(\'target\')]' }
                      { field: 'name', contains: '.' }
                    ]
                  }
                ]
              }
              {
                allOf: [
                  { field: 'type', equals: 'Microsoft.Network/dnszones/TXT' }
                  {
                    anyOf: [
                      { field: 'name', notLike: 'asuid.*' }
                      {
                        count: {
                          field: 'Microsoft.Network/dnszones/TXT/TXTRecords[*].value[*]'
                          where: {
                            field: 'Microsoft.Network/dnszones/TXT/TXTRecords[*].value[*]'
                            notEquals: '[parameters(\'verificationId\')]'
                          }
                        }
                        greater: 0
                      }
                    ]
                  }
                ]
              }
              {
                field: 'type'
                notIn: ['Microsoft.Network/dnszones/CNAME', 'Microsoft.Network/dnszones/TXT', 'Microsoft.Network/dnszones/NS', 'Microsoft.Network/dnszones/SOA']
              }
            ]
          }
        ]
      }
      then: { effect: '[parameters(\'effect\')]' }
    }
  }
}

module grants 'modules/hostname-binder-access.bicep' = {
  name: 'hostname-binder-access'
  scope: resourceGroup(resourceGroupName)
  params: {
    baseName: baseName
    namePrefix: namePrefix
    environmentName: environmentName
    dnsZoneName: dnsZoneName
    roleDefinitionId: role.id
    hostFenceId: hostFence.id
    recordFenceId: recordFence.id
    policyEffect: policyEffect
  }
}

output roleName string = role.properties.roleName
output binderActions array = binderActions
