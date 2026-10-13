import type { PlainKey } from './i18n';

export const settingLabels: Record<string, { label: PlainKey; cat: PlainKey; desc?: PlainKey }> = {
  'planner.enabled': {
    label: 'settings.labelPlannerEnabled',
    cat: 'settings.catSearch',
    desc: 'settings.descPlannerEnabled',
  },
  'planner.expansionMode': {
    label: 'settings.labelPlannerExpansionMode',
    cat: 'settings.catSearch',
    desc: 'settings.descPlannerExpansionMode',
  },
  'planner.maxPhrases': {
    label: 'settings.labelPlannerMaxPhrases',
    cat: 'settings.catSearch',
    desc: 'settings.descPlannerMaxPhrases',
  },
  'planner.prompt': {
    label: 'settings.labelPlannerPrompt',
    cat: 'settings.catSearch',
    desc: 'settings.descPlannerPrompt',
  },
  'retrieval.retrieveTopK': {
    label: 'settings.labelRetrievalRetrieveTopK',
    cat: 'settings.catSearch',
    desc: 'settings.descRetrievalRetrieveTopK',
  },
  'retrieval.maxPerDocument': {
    label: 'settings.labelRetrievalMaxPerDocument',
    cat: 'settings.catSearch',
    desc: 'settings.descRetrievalMaxPerDocument',
  },
  'retrieval.queryAwareBoost': {
    label: 'settings.labelRetrievalQueryAwareBoost',
    cat: 'settings.catSearch',
    desc: 'settings.descRetrievalQueryAwareBoost',
  },
  'retrieval.autoFilter.enabled': {
    label: 'settings.labelRetrievalAutoFilterEnabled',
    cat: 'settings.catSearch',
    desc: 'settings.descRetrievalAutoFilterEnabled',
  },
  'retrieval.autoFilter.rules': {
    label: 'settings.labelRetrievalAutoFilterRules',
    cat: 'settings.catSearch',
    desc: 'settings.descRetrievalAutoFilterRules',
  },
  'retrieval.docTitle.fanout': {
    label: 'settings.labelRetrievalDocTitleFanout',
    cat: 'settings.catSearch',
    desc: 'settings.descRetrievalDocTitleFanout',
  },
  'retrieval.merge.mode': {
    label: 'settings.labelRetrievalMergeMode',
    cat: 'settings.catSearch',
    desc: 'settings.descRetrievalMergeMode',
  },
  'retrieval.merge.rrfK': {
    label: 'settings.labelRetrievalMergeRrfK',
    cat: 'settings.catSearch',
    desc: 'settings.descRetrievalMergeRrfK',
  },
  'retrieval.merge.weights': {
    label: 'settings.labelRetrievalMergeWeights',
    cat: 'settings.catSearch',
    desc: 'settings.descRetrievalMergeWeights',
  },
  'retrieval.merge.caps': {
    label: 'settings.labelRetrievalMergeCaps',
    cat: 'settings.catSearch',
    desc: 'settings.descRetrievalMergeCaps',
  },
  'retrieval.userIntentUnion.enabled': {
    label: 'settings.labelRetrievalUserIntentUnionEnabled',
    cat: 'settings.catSearch',
    desc: 'settings.descRetrievalUserIntentUnionEnabled',
  },
  'retrieval.userIntentUnion.mode': {
    label: 'settings.labelRetrievalUserIntentUnionMode',
    cat: 'settings.catSearch',
    desc: 'settings.descRetrievalUserIntentUnionMode',
  },
  'retrieval.userIntentUnion.cap': {
    label: 'settings.labelRetrievalUserIntentUnionCap',
    cat: 'settings.catSearch',
    desc: 'settings.descRetrievalUserIntentUnionCap',
  },
  'retrieval.userIntentUnion.rrfK': {
    label: 'settings.labelRetrievalUserIntentUnionRrfK',
    cat: 'settings.catSearch',
    desc: 'settings.descRetrievalUserIntentUnionRrfK',
  },
  'retrieval.rerank.enabled': {
    label: 'settings.labelRetrievalRerankEnabled',
    cat: 'settings.catSearch',
    desc: 'settings.descRetrievalRerankEnabled',
  },
  'retrieval.rerank.candidateK': {
    label: 'settings.labelRetrievalRerankCandidateK',
    cat: 'settings.catSearch',
    desc: 'settings.descRetrievalRerankCandidateK',
  },
  'retrieval.rerank.maxChunkLength': {
    label: 'settings.labelRetrievalRerankMaxChunkLength',
    cat: 'settings.catSearch',
    desc: 'settings.descRetrievalRerankMaxChunkLength',
  },
  'rag.topK': {
    label: 'settings.labelRagTopK',
    cat: 'settings.catSearch',
    desc: 'settings.descRagTopK',
  },
  'synthesis.contextTopK': {
    label: 'settings.labelSynthesisContextTopK',
    cat: 'settings.catAnswer',
    desc: 'settings.descSynthesisContextTopK',
  },
  'synthesis.maxDocs': {
    label: 'settings.labelSynthesisMaxDocs',
    cat: 'settings.catAnswer',
    desc: 'settings.descSynthesisMaxDocs',
  },
  'synthesis.maxTokens': {
    label: 'settings.labelSynthesisMaxTokens',
    cat: 'settings.catAnswer',
    desc: 'settings.descSynthesisMaxTokens',
  },
  'synthesis.generationPrompt': {
    label: 'settings.labelSynthesisGenerationPrompt',
    cat: 'settings.catAnswer',
    desc: 'settings.descSynthesisGenerationPrompt',
  },
  'synthesis.instructions': {
    label: 'settings.labelSynthesisInstructions',
    cat: 'settings.catAnswer',
    desc: 'settings.descSynthesisInstructions',
  },
  'synthesis.temperature': {
    label: 'settings.labelSynthesisTemperature',
    cat: 'settings.catAnswer',
    desc: 'settings.descSynthesisTemperature',
  },
  'knowledge.switchRetentionDays': {
    label: 'settings.labelKnowledgeSwitchRetentionDays',
    cat: 'settings.catSearch',
    desc: 'settings.descKnowledgeSwitchRetentionDays',
  },
  'assistant.enabled': {
    label: 'settings.labelAssistantEnabled',
    cat: 'settings.catAssistant',
    desc: 'settings.descAssistantEnabled',
  },
  'assistant.dailyTokens': {
    label: 'settings.labelAssistantDailyTokens',
    cat: 'settings.catAssistant',
    desc: 'settings.descAssistantDailyTokens',
  },
  'assistant.model': {
    label: 'settings.labelAssistantModel',
    cat: 'settings.catAssistant',
    desc: 'settings.descAssistantModel',
  },
  'skills.defaultPassThreshold': {
    label: 'settings.labelSkillsDefaultPassThreshold',
    cat: 'settings.catSkills',
    desc: 'settings.descSkillsDefaultPassThreshold',
  },
  'skills.testModel': {
    label: 'settings.labelSkillsTestModel',
    cat: 'settings.catSkills',
    desc: 'settings.descSkillsTestModel',
  },
  'skills.judgeModel': {
    label: 'settings.labelSkillsJudgeModel',
    cat: 'settings.catSkills',
    desc: 'settings.descSkillsJudgeModel',
  },
  'answers.writtenStandard': {
    label: 'settings.labelAnswersWrittenStandard',
    cat: 'settings.catAnswer',
    desc: 'settings.descAnswersWrittenStandard',
  },
  'answers.languageInstructions.nb': {
    label: 'settings.labelAnswersLanguageInstructionsNb',
    cat: 'settings.catAnswer',
    desc: 'settings.descAnswersLanguageInstructionsNb',
  },
  'answers.languageInstructions.nn': {
    label: 'settings.labelAnswersLanguageInstructionsNn',
    cat: 'settings.catAnswer',
    desc: 'settings.descAnswersLanguageInstructionsNn',
  },
  'answers.languageInstructions.en': {
    label: 'settings.labelAnswersLanguageInstructionsEn',
    cat: 'settings.catAnswer',
    desc: 'settings.descAnswersLanguageInstructionsEn',
  },
  'playground.enabled': {
    label: 'settings.labelPlaygroundEnabled',
    cat: 'settings.catPlayground',
    desc: 'settings.descPlaygroundEnabled',
  },
  'usage.monthlyTokens': {
    label: 'settings.labelUsageMonthlyTokens',
    cat: 'settings.catUsage',
    desc: 'settings.descUsageMonthlyTokens',
  },
  'usage.tenantCallsPerMinute': {
    label: 'settings.labelUsageTenantCallsPerMinute',
    cat: 'settings.catUsage',
    desc: 'settings.descUsageTenantCallsPerMinute',
  },
  'batch.approvalLimitNok': {
    label: 'settings.labelBatchApprovalLimitNok',
    cat: 'settings.catUsage',
    desc: 'settings.descBatchApprovalLimitNok',
  },
  'services.defaultModel': {
    label: 'settings.labelServicesDefaultModel',
    cat: 'settings.catModels',
    desc: 'settings.descServicesDefaultModel',
  },
  'retention.class': {
    label: 'settings.labelRetentionClass',
    cat: 'settings.catRetention',
    desc: 'settings.descRetentionClass',
  },
  'retention.auditDays': {
    label: 'settings.labelRetentionAuditDays',
    cat: 'settings.catRetention',
    desc: 'settings.descRetentionAuditDays',
  },
};
