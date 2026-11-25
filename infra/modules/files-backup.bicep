param name string
param location string
param tags object
param storageAccountName string
param shareName string
param retentionDays int = 30

@description('UTC; Azure starts the backup within two hours of it.')
param scheduleTime string = '01:00'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource vault 'Microsoft.RecoveryServices/vaults@2024-04-01' = {
  name: name
  location: location
  tags: tags
  sku: { name: 'RS0', tier: 'Standard' }
  properties: {
    publicNetworkAccess: 'Enabled'
    securitySettings: {
      softDeleteSettings: { softDeleteState: 'Enabled', softDeleteRetentionPeriodInDays: 14 }
    }
  }
}

var runAt = '2026-01-01T${scheduleTime}:00Z'

resource policy 'Microsoft.RecoveryServices/vaults/backupPolicies@2024-04-01' = {
  parent: vault
  name: 'files-daily-${retentionDays}d'
  properties: {
    backupManagementType: 'AzureStorage'
    workLoadType: 'AzureFileShare'
    timeZone: 'UTC'
    schedulePolicy: {
      schedulePolicyType: 'SimpleSchedulePolicy'
      scheduleRunFrequency: 'Daily'
      scheduleRunTimes: [runAt]
    }
    retentionPolicy: {
      retentionPolicyType: 'LongTermRetentionPolicy'
      dailySchedule: {
        retentionTimes: [runAt]
        retentionDuration: { count: retentionDays, durationType: 'Days' }
      }
    }
  }
}

resource container 'Microsoft.RecoveryServices/vaults/backupFabrics/protectionContainers@2024-04-01' = {
  name: '${vault.name}/Azure/storagecontainer;Storage;${resourceGroup().name};${storageAccountName}'
  properties: {
    backupManagementType: 'AzureStorage'
    containerType: 'StorageContainer'
    sourceResourceId: storage.id
  }
}

resource share 'Microsoft.RecoveryServices/vaults/backupFabrics/protectionContainers/protectedItems@2024-04-01' = {
  parent: container
  name: 'AzureFileShare;${shareName}'
  properties: {
    protectedItemType: 'AzureFileShareProtectedItem'
    sourceResourceId: storage.id
    policyId: policy.id
  }
}

output vaultName string = vault.name
