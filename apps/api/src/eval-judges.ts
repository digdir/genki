import type { Principal } from '@genai/contracts';
import { criteriaJudge, criteriaJudgeId, type Evaluator } from '@genai/eval';
import type { ModelChoice } from './model-choice.js';

/**
 * The judges an eval run gets for itself: their models are picked for the run's tenant, from
 * another family than the models that wrote the answer, and their calls are charged there.
 */
export const runJudges =
  (choice: () => ModelChoice) =>
  (principal: Principal): Map<string, Evaluator> => {
    const tenant = principal.tenant;
    if (!tenant) return new Map();
    const models = choice();
    const meter = models.meter();
    return new Map([
      [
        criteriaJudgeId,
        criteriaJudge(
          async (writers) => {
            const id = models.pickJudge(await models.usable(tenant), tenant, writers);
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
