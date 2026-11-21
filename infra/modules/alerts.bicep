param name string
param environmentName string
param location string
param tags object
param workspaceId string
param insightsName string
param apiAppName string
param workerAppName string

@description('The Docling server app (issue 922): alerts on a replica out of memory.')
param doclingAppName string

@description('Memory of a Docling replica in GiB, as the container apps module sets it.')
param doclingMemoryGiB int

@description('Full URL of the API health endpoint the availability test calls.')
param healthUrl string

@description('Email addresses, comma separated. Empty means the alerts fire without notifying anyone.')
param emails string

@allowed([300, 900])
param healthCheckFrequencySeconds int

param thresholds object

param postgresServerId string

param postgresUserConnections int

@description('The nightly database copy\'s job; empty: no alert on it.')
param backupJobName string = ''

@description('Service Health for the services genki uses in its regions. The rule is scoped to the subscription.')
param serviceHealthAlert bool = false

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

resource dbDown 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${name}-db-down'
  location: 'global'
  tags: tags
  properties: {
    description: 'The platform database did not answer Azure\'s liveness check for 5 minutes; see docs/runbook.md, "Database down".'
    severity: 1
    enabled: true
    scopes: [postgresServerId]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'is-db-alive'
          metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
          metricName: 'is_db_alive'
          operator: 'LessThan'
          threshold: 1
          timeAggregation: 'Maximum'
        }
      ]
    }
    autoMitigate: true
    actions: [{ actionGroupId: group.id }]
  }
}

resource postgresConnections 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${name}-postgres-connections'
  location: 'global'
  tags: tags
  properties: {
    description: 'The platform database had more than 80 % of its ${postgresUserConnections} user connections open; see docs/runbook.md, "Database connections".'
    severity: 2
    enabled: true
    scopes: [postgresServerId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'active-connections'
          metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
          metricName: 'active_connections'
          operator: 'GreaterThan'
          threshold: postgresUserConnections * 8 / 10
          timeAggregation: 'Maximum'
        }
      ]
    }
    autoMitigate: true
    actions: [{ actionGroupId: group.id }]
  }
}

resource docling 'Microsoft.App/containerApps@2025-02-02-preview' existing = {
  name: doclingAppName
}

// The 1-minute peak of any replica above 85 % of its memory: in test on 2026-11-21 the killed replica passed it about
// six minutes before the kill (issue 922).
resource doclingMemory 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${name}-docling-memory'
  location: 'global'
  tags: tags
  properties: {
    description: 'A Docling replica used more than 85 % of its ${doclingMemoryGiB} GiB; see docs/runbook.md, "Docling out of memory".'
    severity: 2
    enabled: true
    scopes: [docling.id]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT1M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'working-set'
          metricNamespace: 'Microsoft.App/containerApps'
          metricName: 'WorkingSetBytes'
          dimensions: [{ name: 'podName', operator: 'Include', values: ['*'] }]
          operator: 'GreaterThan'
          threshold: doclingMemoryGiB * 1073741824 * 85 / 100
          timeAggregation: 'Maximum'
        }
      ]
    }
    autoMitigate: true
    actions: [{ actionGroupId: group.id }]
  }
}

var consoleLogs = 'ContainerAppConsoleLogs | where ContainerAppName in (\'${apiAppName}\', \'${workerAppName}\')'

var slowByDesignPaths = [
  '/chat/completions'
  '/uploads'
  '/playground/runs'
  '/definitions/test-run'
  '/definitions/complete'
  '/assistant/turns'
  '/test-runs'
  '/diagnostics/plan'
  '/diagnostics/retrieve'
  '/api/tools/call'
  '/api/mcp'
  '/a2a'
]
var slowByDesignList = join(map(slowByDesignPaths, path => '\'${path}\''), ', ')

var appLogAlerts = [
  {
    key: 'docling-out-of-memory'
    title: 'Docling replica out of memory'
    description: 'A Docling replica was killed with exit code 137, which usually means it ran out of its ${doclingMemoryGiB} GiB; the conversions it held are submitted again. See docs/runbook.md, "Docling out of memory" (issue 922).'
    severity: 2
    frequency: 'PT5M'
    window: 'PT5M'
    query: 'ContainerAppSystemLogs | where ContainerAppName == \'${doclingAppName}\' and Reason == \'ContainerTerminated\' and Log has "exit code \'137\'" | project TimeGenerated, ReplicaName, Log'
    measure: ''
    aggregation: 'Count'
    threshold: 1
  }
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
    key: 'worker-jobs'
    title: 'Worker jobs failing or waiting'
    description: 'At least ${thresholds.workerFailures} ingestion runs failed, knowledge jobs were refused or knowledge server calls failed in the last hour, or the state register is stale (ADR 0058), or a queued job waited more than ${thresholds.queueWaitMinutes} minutes.'
    severity: 3
    frequency: 'PT15M'
    window: 'PT1H'
    query: '${consoleLogs} | where Log has_any (\'ingestion run failed\', \'knowledge job refused\', \'knowledge server unreachable\', \'knowledge reconciler failed\', \'state register stale\', \'queue stats\') | extend entry = parse_json(Log) | extend msg = tostring(entry.msg) | summarize failures = countif(msg in (\'ingestion run failed\', \'knowledge job refused\', \'knowledge server unreachable\', \'knowledge reconciler failed\')), stale = countif(msg == \'state register stale\'), waiting = countif(msg == \'queue stats\' and toint(entry.oldestQueuedSeconds) > ${thresholds.queueWaitMinutes * 60}) | extend problems = iff(failures >= ${thresholds.workerFailures} or stale > 0 or waiting > 0, 1, 0)'
    measure: 'problems'
    aggregation: 'Maximum'
    threshold: 1
  }
  {
    key: 'catalog-skipped'
    title: 'Catalog entry skipped'
    description: 'The API or the worker left a stored catalog entry out when it rebuilt the catalog, so a dataset, model or endpoint runs on its seed or is missing; see docs/runbook.md, "Catalog entry skipped".'
    severity: 2
    frequency: 'PT5M'
    window: 'PT15M'
    query: '${consoleLogs} | where Log has \'catalog entry skipped\' | extend entry = parse_json(Log) | project TimeGenerated, ContainerAppName, entryKind = tostring(entry.kind), entryId = tostring(entry.id), reason = tostring(entry.reason)'
    measure: ''
    aggregation: 'Count'
    threshold: 1
  }
  {
    key: 'api-latency'
    title: 'API slow'
    description: 'The API\'s 95th percentile response time was over ${thresholds.latencySeconds} s over 15 minutes, with at least ${thresholds.latencyMinRequests} requests; health checks, uploads and routes that wait for a model answer (playground, service calls, assistant, A2A, MCP) are left out.'
    severity: 2
    frequency: 'PT5M'
    window: 'PT15M'
    query: 'ContainerAppHTTPLogs | where ContainerAppName == \'${apiAppName}\' and StatusCode > 0 and Path != \'/health\' and not(Path has_any (${slowByDesignList})) | summarize total = count(), p95 = percentile(todouble(RequestDuration), 95) | where total >= ${thresholds.latencyMinRequests} | extend seconds = p95 / 1000.0'
    measure: 'seconds'
    aggregation: 'Maximum'
    threshold: thresholds.latencySeconds
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

var backupAlerts = empty(backupJobName)
  ? []
  : [
      {
        key: 'platform-backup'
        title: 'No database copy'
        description: 'The nightly copy of the platform database (${backupJobName}) uploaded nothing in the last day; see docs/runbook.md, "Backups".'
        severity: 3
        frequency: 'PT1H'
        window: 'P1D'
        query: 'ContainerAppConsoleLogs | where JobName == \'${backupJobName}\' and Log has \'platform backup uploaded\' | extend entry = parse_json(Log) | where tostring(entry.msg) == \'platform backup uploaded\' | project TimeGenerated, blob = tostring(entry.blob), bytes = tolong(entry.bytes)'
        measure: ''
        aggregation: 'Count'
        operator: 'LessThan'
        threshold: 1
      }
    ]

var logAlerts = concat(appLogAlerts, backupAlerts)

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
            operator: rule.?operator ?? 'GreaterThanOrEqual'
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

resource serviceHealth 'Microsoft.Insights/activityLogAlerts@2023-01-01-preview' = if (serviceHealthAlert) {
  name: '${name}-service-health'
  location: 'global'
  tags: tags
  properties: {
    description: 'Azure reports an incident, planned maintenance, a health advisory or a security advisory for a service genki uses, in West Europe or Sweden Central.'
    enabled: true
    scopes: [subscription().id]
    condition: {
      allOf: [
        { field: 'category', equals: 'ServiceHealth' }
        {
          anyOf: [
            { field: 'properties.incidentType', equals: 'Incident' }
            { field: 'properties.incidentType', equals: 'Maintenance' }
            { field: 'properties.incidentType', equals: 'Informational' }
            { field: 'properties.incidentType', equals: 'ActionRequired' }
            { field: 'properties.incidentType', equals: 'Security' }
          ]
        }
        {
          field: 'properties.impactedServices[*].ServiceName'
          containsAny: [
            'Azure Database for PostgreSQL flexible servers'
            'Azure Container Apps'
            'Key Vault'
            'Storage'
            'Foundry Models'
            'Azure OpenAI Service'
          ]
        }
        {
          field: 'properties.impactedServices[*].ImpactedRegions[*].RegionName'
          containsAny: ['West Europe', 'Sweden Central', 'Global']
        }
      ]
    }
    actions: { actionGroups: [{ actionGroupId: group.id }] }
  }
}

// Declared to switch off the rule Azure makes, which mails everyone with a monitoring role on the subscription.
resource failureAnomalies 'Microsoft.AlertsManagement/smartDetectorAlertRules@2021-04-01' = {
  name: 'Failure Anomalies - ${insights.name}'
  location: 'global'
  tags: tags
  properties: {
    description: 'Failure Anomalies notifies you of an unusual rise in the rate of failed HTTP requests or dependency calls.'
    state: 'Disabled'
    severity: 'Sev3'
    frequency: 'PT1M'
    detector: { id: 'FailureAnomaliesDetector' }
    scope: [insights.id]
    actionGroups: { groupIds: [group.id] }
  }
}

output actionGroupId string = group.id
