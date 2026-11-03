// The knowledge server's own network, peered with each environment's network. Peerings do not
// pass traffic on, so test's network reaches this one and never prod's.
param name string
param location string
param tags object
param addressPrefix string
param serverName string

@description('Resource ids of the networks whose apps reach the knowledge server.')
param clientVnetIds array

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
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

var linked = concat([vnet.id], clientVnetIds)

@batchSize(1)
resource links 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for id in linked: {
  parent: dns
  name: '${last(split(id, '/'))}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: id }
  }
}]

@batchSize(1)
resource peerings 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-05-01' = [for id in clientVnetIds: {
  parent: vnet
  name: 'to-${last(split(id, '/'))}'
  properties: {
    remoteVirtualNetwork: { id: id }
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: false
    allowGatewayTransit: false
    useRemoteGateways: false
  }
}]

output vnetId string = vnet.id
output subnetId string = vnet.properties.subnets[0].id
output dnsZoneId string = dns.id
