param name string

@description('A month\'s amount in the billing currency.')
param amount int

@description('The first of a month; Azure refuses to change it later.')
param startDate string
param actionGroupId string

@description('{ threshold (percent of the amount), type: Actual or Forecasted }')
param notifications array

resource budget 'Microsoft.Consumption/budgets@2023-05-01' = {
  name: name
  properties: {
    category: 'Cost'
    amount: amount
    timeGrain: 'Monthly'
    timePeriod: { startDate: startDate }
    notifications: toObject(
      notifications,
      n => '${toLower(n.type)}-${n.threshold}',
      n => {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: n.threshold
        thresholdType: n.type
        contactGroups: [actionGroupId]
        contactEmails: []
      }
    )
  }
}
