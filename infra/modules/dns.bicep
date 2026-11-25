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

@description('Names genki assigns to hosted services, e.g. kunnskap.apps, all pointing at the assistant host.')
param hostedLabels array = []
param hostedTarget string = ''
param hostedVerificationId string = ''
@description('Puts the hosted names in a zone of their own, apps.<zoneName>, delegated from this one, which the hostname binder may write.')
param appsZone bool = false

var appsSuffix = '.apps'
var parentLabels = appsZone ? [] : hostedLabels
var childLabels = appsZone ? map(hostedLabels, label => substring(label, 0, length(label) - length(appsSuffix))) : []

resource hostedCnames 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = [for label in parentLabels: {
  parent: zone
  name: label
  properties: {
    TTL: 300
    CNAMERecord: { cname: hostedTarget }
  }
}]

resource hostedVerifications 'Microsoft.Network/dnsZones/TXT@2018-05-01' = [for label in parentLabels: {
  parent: zone
  name: 'asuid.${label}'
  properties: {
    TTL: 300
    TXTRecords: [{ value: [hostedVerificationId] }]
  }
}]

resource apps 'Microsoft.Network/dnsZones@2018-05-01' = if (appsZone) {
  name: 'apps.${zoneName}'
  location: 'global'
  tags: tags
}

resource appsCnames 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = [for label in childLabels: {
  parent: apps
  name: label
  properties: {
    TTL: 300
    CNAMERecord: { cname: hostedTarget }
  }
}]

resource appsVerifications 'Microsoft.Network/dnsZones/TXT@2018-05-01' = [for label in childLabels: {
  parent: apps
  name: 'asuid.${label}'
  properties: {
    TTL: 300
    TXTRecords: [{ value: [hostedVerificationId] }]
  }
}]

resource appsDelegation 'Microsoft.Network/dnsZones/NS@2018-05-01' = if (appsZone) {
  parent: zone
  name: 'apps'
  dependsOn: [appsCnames, appsVerifications]
  properties: {
    TTL: 3600
    NSRecords: map(appsZone ? apps!.properties.nameServers : [], ns => { nsdname: ns })
  }
}

output nameServers array = zone.properties.nameServers
output appsZoneName string = appsZone ? apps.name : ''
