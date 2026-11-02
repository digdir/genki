/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-cycles',
      comment: 'runtime import cycles; cycles made only of type imports vanish at compile time',
      severity: 'error',
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'contracts-are-leaf',
      comment: 'contracts depend on nothing but the standard library',
      severity: 'error',
      from: { path: '^packages/contracts/', pathNot: '\\.test\\.ts$' },
      to: { pathNot: '^packages/contracts/' },
    },
    {
      name: 'kernel-knows-only-contracts',
      severity: 'error',
      from: { path: '^packages/kernel/', pathNot: '\\.test\\.ts$' },
      to: {
        pathNot: ['^packages/kernel/', '^packages/contracts/', '^node_modules/@genai/contracts'],
      },
    },
    {
      name: 'vendor-sdks-only-in-providers',
      comment:
        'model, search, database and document library clients may only be imported by provider packages',
      severity: 'error',
      from: { pathNot: '^packages/providers-' },
      to: {
        path: 'node_modules/(openai|@anthropic-ai|typesense|pg|pg-boss|postgres|drizzle-orm|@azure|pdfjs-dist|mammoth|hyparquet|hyparquet-compressors)/',
      },
    },
    {
      name: 'vendor-providers-only-in-composition',
      comment: 'ADR 0023: vendor-named providers are wired in by composition roots',
      severity: 'error',
      from: {
        pathNot: [
          '^packages/providers-',
          '^packages/composition/',
          '^apps/api/src/(composition|main)\\.ts$',
          '^apps/worker/src/main\\.ts$',
          '^apps/parity/',
          '^packages/[^/]+/src/scripts/',
          '\\.test\\.tsx?$',
        ],
      },
      to: {
        path: '^packages/providers-(openai|anthropic|typesense|typesense-writer|colbert|langfuse|pgvector|pgboss)/',
      },
    },
    {
      name: 'not-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'only-apps-compose',
      comment: 'packages never import apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.test.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['source', 'import', 'types', 'default'],
    },
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^(packages|apps)/[^/]+/dist/' },
  },
};
