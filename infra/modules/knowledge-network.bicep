// The knowledge server's own network, peered with its environment's network, and the server's private DNS zone,
// linked to both. The other side of the peering is modules/peering.bicep, on the environment's network.
param name string
param location string
param tags object
param addressPrefix string
param serverName string

@description('Resource id of the environment\'s network, whose apps reach the knowledge server.')
param environmentVnetId string

resource vnet 'Microsoft.Network/virtualNetworks@2024-10-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [addressPrefix] }
    subnets: [
      {
        name: 'postgres'
        properties: {
          addressPrefix: addressPrefix
          delegations: [{ name: 'postgres', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }]
        }
      }
    ]
  }
}

resource dns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: '${serverName}.private.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

@batchSize(1)
resource links 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for id in [vnet.id, environmentVnetId]: {
  parent: dns
  name: '${last(split(id, '/'))}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: id }
  }
}]

resource peering 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-10-01' = {
  parent: vnet
  name: 'to-${last(split(environmentVnetId, '/'))}'
  properties: {
    remoteVirtualNetwork: { id: environmentVnetId }
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: false
    allowGatewayTransit: false
    useRemoteGateways: false
  }
}

output vnetId string = vnet.id
output subnetId string = vnet.properties.subnets[0].id
output dnsZoneId string = dns.id
