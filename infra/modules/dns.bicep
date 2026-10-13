param zoneName string
param tags object
param verificationId string

@description('One entry per hostname in the zone: label (e.g. api) and target (the container app default FQDN).')
param records array

resource zone 'Microsoft.Network/dnsZones@2018-05-01' = {
  name: zoneName
  location: 'global'
  tags: tags
}

resource cnames 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = [for record in records: {
  parent: zone
  name: record.label
  properties: {
    TTL: 300
    CNAMERecord: { cname: record.target }
  }
}]

resource verifications 'Microsoft.Network/dnsZones/TXT@2018-05-01' = [for record in records: {
  parent: zone
  name: 'asuid.${record.label}'
  properties: {
    TTL: 300
    TXTRecords: [{ value: [verificationId] }]
  }
}]

output nameServers array = zone.properties.nameServers
