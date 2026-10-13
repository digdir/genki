using '../main.bicep'

param environmentName = 'test'
param location = 'norwayeast'
param postgresAdminGroupObjectId = readEnvironmentVariable('PG_ADMIN_GROUP_OBJECT_ID')
param postgresAdminGroupName = readEnvironmentVariable('PG_ADMIN_GROUP_NAME')
param deployPrincipalId = readEnvironmentVariable('DEPLOY_PRINCIPAL_ID', '')
param appIdentityIsPostgresAdmin = true
param keyVaultSecretNames = []
param minReplicas = 1
param maxReplicas = 2
