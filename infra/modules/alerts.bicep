param name string
param environmentName string
param location string
param tags object
param workspaceId string
param insightsName string
param apiAppName string
param workerAppName string

@description('Full URL of the API health endpoint the availability test calls.')
param healthUrl string

@description('Email addresses, comma separated. Empty means the alerts fire without notifying anyone.')
param emails string

@allowed([300, 900])
param healthCheckFrequencySeconds int

param thresholds object

resource insights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: insightsName
}

var receivers = filter(map(split(emails, ','), email => trim(email)), email => !empty(email))

resource group 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${name}-alerts'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: take('genki-${environmentName}', 12)
    enabled: true
    emailReceivers: map(receivers, (email, i) => {
      name: 'email-${i}'
      emailAddress: email
      useCommonAlertSchema: true
    })
  }
}

var healthTestName = '${name}-api-health'

resource healthTest 'Microsoft.Insights/webtests@2022-06-15' = {
  name: healthTestName
  location: location
  tags: union(tags, { 'hidden-link:${insights.id}': 'Resource' })
  kind: 'standard'
  properties: {
    SyntheticMonitorId: healthTestName
    Name: 'API /health'
    Enabled: true
    Frequency: healthCheckFrequencySeconds
    Timeout: 30
    Kind: 'standard'
    RetryEnabled: true
    Locations: [{ Id: 'emea-nl-ams-azr' }, { Id: 'emea-gb-db3-azr' }, { Id: 'emea-se-sto-edge' }]
    Request: { RequestUrl: healthUrl, HttpVerb: 'GET', ParseDependentRequests: false }
    ValidationRules: { ExpectedHttpStatusCode: 200, SSLCheck: true, SSLCertRemainingLifetimeCheck: 7 }
  }
}

resource apiDown 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${name}-api-down'
  location: 'global'
  tags: union(tags, { 'hidden-link:${insights.id}': 'Resource', 'hidden-link:${healthTest.id}': 'Resource' })
  properties: {
    description: 'GET /health on the API failed from at least two of three test locations.'
    severity: 1
    enabled: true
    scopes: [healthTest.id, insights.id]
    evaluationFrequency: 'PT1M'
    windowSize: healthCheckFrequencySeconds == 300 ? 'PT5M' : 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.WebtestLocationAvailabilityCriteria'
      webTestId: healthTest.id
      componentId: insights.id
      failedLocationCount: 2
    }
    actions: [{ actionGroupId: group.id }]
  }
}

var consoleLogs = 'ContainerAppConsoleLogs | where ContainerAppName in (\'${apiAppName}\', \'${workerAppName}\')'

var logAlerts = [
  {
    key: 'api-errors'
    title: 'API error rate'
    description: 'At least ${thresholds.errorRatePercent} % of API responses were 5xx over 15 minutes, with at least ${thresholds.errorRateMinRequests} requests.'
    severity: 2
    frequency: 'PT5M'
    window: 'PT15M'
    query: 'ContainerAppHTTPLogs | where ContainerAppName == \'${apiAppName}\' and StatusCode > 0 | summarize total = count(), failed = countif(StatusCode >= 500) | where total >= ${thresholds.errorRateMinRequests} | extend percent = 100.0 * failed / total'
    measure: 'percent'
    aggregation: 'Maximum'
    threshold: thresholds.errorRatePercent
  }
  {
    key: 'model-provider'
    title: 'Model provider failures'
    description: 'At least ${thresholds.modelFailures} model calls failed as unavailable or rate limited over 15 minutes.'
    severity: 2
    frequency: 'PT5M'
    window: 'PT15M'
    query: '${consoleLogs} | where Log has \'model call failed\' | extend entry = parse_json(Log) | where tostring(entry.msg) == \'model call failed\' and tostring(entry.code) in (\'unavailable\', \'rate_limited\') | project TimeGenerated, ContainerAppName, model = tostring(entry.model), code = tostring(entry.code), tenant = tostring(entry.tenant)'
    measure: ''
    aggregation: 'Count'
    threshold: thresholds.modelFailures
  }
  {
    key: 'ingestion'
    title: 'Ingestion failures'
    description: 'An ingestion run failed, a knowledge job was refused, or the job queue or knowledge server failed in the last hour.'
    severity: 3
    frequency: 'PT15M'
    window: 'PT1H'
    query: '${consoleLogs} | where Log has_any (\'ingestion run failed\', \'knowledge job refused\', \'knowledge server unreachable\', \'knowledge reconciler failed\', \'job queue error\') | extend entry = parse_json(Log) | extend msg = tostring(entry.msg) | where msg in (\'ingestion run failed\', \'knowledge job refused\', \'knowledge server unreachable\', \'knowledge reconciler failed\', \'job queue error\') | project TimeGenerated, ContainerAppName, msg, Log'
    measure: ''
    aggregation: 'Count'
    threshold: thresholds.ingestionFailures
  }
  {
    key: 'altinn'
    title: 'Altinn unavailable'
    description: 'At least ${thresholds.altinnFailures} Altinn rights lookups or token exchanges failed over 15 minutes.'
    severity: 2
    frequency: 'PT5M'
    window: 'PT15M'
    query: 'ContainerAppConsoleLogs | where ContainerAppName == \'${apiAppName}\' | where Log has \'altinn\' | extend entry = parse_json(Log) | extend msg = tostring(entry.msg) | where msg in (\'altinn actions failed\', \'altinn token not fetched at boot\') | project TimeGenerated, msg, error = tostring(entry.error)'
    measure: ''
    aggregation: 'Count'
    threshold: thresholds.altinnFailures
  }
  {
    key: 'login-keys'
    title: 'Ansattporten or Maskinporten keys unavailable'
    description: 'The API could not fetch the signing keys of Ansattporten or Maskinporten, so logins fail.'
    severity: 1
    frequency: 'PT5M'
    window: 'PT15M'
    query: 'ContainerAppConsoleLogs | where ContainerAppName == \'${apiAppName}\' | where Log has \'login keys not fetched\' | extend entry = parse_json(Log) | where tostring(entry.msg) == \'login keys not fetched\' | project TimeGenerated, issuer = tostring(entry.issuer), status = tostring(entry.status), error = tostring(entry.error)'
    measure: ''
    aggregation: 'Count'
    threshold: thresholds.loginKeyFailures
  }
]

resource rules 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = [for rule in logAlerts: {
  name: '${name}-${rule.key}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: '${name}: ${rule.title}'
    description: rule.description
    severity: rule.severity
    enabled: true
    evaluationFrequency: rule.frequency
    windowSize: rule.window
    scopes: [workspaceId]
    // The tables appear with the first log line, after the first deploy of a new environment.
    skipQueryValidation: true
    autoMitigate: true
    criteria: {
      allOf: [
        union(
          {
            query: rule.query
            timeAggregation: rule.aggregation
            operator: 'GreaterThanOrEqual'
            threshold: rule.threshold
            failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
          },
          empty(rule.measure) ? {} : { metricMeasureColumn: rule.measure }
        )
      ]
    }
    actions: { actionGroups: [group.id] }
  }
}]

output actionGroupId string = group.id
