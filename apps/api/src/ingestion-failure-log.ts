import type { ApiLog } from './failure-log.js';
import type { IngestionService } from './ingestion.js';

export const logFailedIngestion = (ingestion: Pick<IngestionService, 'onFinished'>, log: ApiLog) =>
  ingestion.onFinished((run) => {
    if (run.status === 'failed')
      log('ingestion run failed', {
        execution: run.id,
        dataset: run.dataset,
        pipeline: run.pipeline,
        backend: run.backend,
      });
  });
