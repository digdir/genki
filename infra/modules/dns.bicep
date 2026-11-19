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

@description('Names genki assigns to hosted services, e.g. kunnskap.apps, all pointing at the assistant host.')
param hostedLabels array = []
param hostedTarget string = ''
param hostedVerificationId string = ''

resource hostedCnames 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = [for label in hostedLabels: {
  parent: zone
  name: label
  properties: {
    TTL: 300
    CNAMERecord: { cname: hostedTarget }
  }
}]

resource hostedVerifications 'Microsoft.Network/dnsZones/TXT@2018-05-01' = [for label in hostedLabels: {
  parent: zone
  name: 'asuid.${label}'
  properties: {
    TTL: 300
    TXTRecords: [{ value: [hostedVerificationId] }]
  }
}]

output nameServers array = zone.properties.nameServers
