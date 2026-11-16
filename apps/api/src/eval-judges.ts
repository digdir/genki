import type { Principal } from '@genai/contracts';
import { criteriaJudge, criteriaJudgeId, type Evaluator } from '@genai/eval';
import type { ModelChoice } from './model-choice.js';

/** Judges made per eval run, with models picked and charged for the run's tenant. */
export const runJudges =
  (choice: () => ModelChoice) =>
  (principal: Principal, run: { avoid: string[] } = { avoid: [] }): Map<string, Evaluator> => {
    const tenant = principal.tenant;
    if (!tenant) return new Map();
    const models = choice();
    const meter = models.meter();
    return new Map([
      [
        criteriaJudgeId,
        criteriaJudge(
          async (writers) => {
            const id = models.pickJudge(await models.usable(tenant), tenant, [
              ...writers,
              ...run.avoid,
            ]);
            return id ? models.judgeModel(principal, tenant, id, 'builder', meter) : undefined;
          },
          () => ({
            inputTokens: meter.inputTokens,
            outputTokens: meter.outputTokens,
            costMicroNok: meter.costMicroNok(),
          }),
        ),
      ],
    ]);
  };
