param zoneName string
param tags object
param verificationId string

@description('One entry per hostname in the zone: label (e.g. api), target (the container app default FQDN) and, for an app in another environment, its verificationId.')
param records array
@description('Entries for apps in another environment, each with its own verificationId.')
param otherRecords array = []

var all = concat(records, otherRecords)

resource zone 'Microsoft.Network/dnsZones@2018-05-01' = {
  name: zoneName
  location: 'global'
  tags: tags
}

resource cnames 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = [for record in all: {
  parent: zone
  name: record.label
  properties: {
    TTL: 300
    CNAMERecord: { cname: record.target }
  }
}]

resource verifications 'Microsoft.Network/dnsZones/TXT@2018-05-01' = [for record in all: {
  parent: zone
  name: 'asuid.${record.label}'
  properties: {
    TTL: 300
    TXTRecords: [{ value: [record.?verificationId ?? verificationId] }]
  }
}]

output nameServers array = zone.properties.nameServers
