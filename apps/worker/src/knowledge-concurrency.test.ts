import { describe, expect, it } from 'vitest';
import {
  indexConcurrencyOf,
  knowledgePoolSizeOf,
  knowledgeWork,
  type KnowledgeHandlerDeps,
} from './knowledge-handlers.js';

describe('how many documents the worker writes at once', () => {
  it('index and fill jobs are worked 8 at a time unless KNOWLEDGE_INDEX_CONCURRENCY says otherwise', () => {
    expect(indexConcurrencyOf({})).toBe(8);
    expect(indexConcurrencyOf({ KNOWLEDGE_INDEX_CONCURRENCY: '1' })).toBe(1);
    expect(indexConcurrencyOf({ KNOWLEDGE_INDEX_CONCURRENCY: '16' })).toBe(16);
    const work = knowledgeWork({ indexConcurrency: 4 } as KnowledgeHandlerDeps);
    expect(work.knowledge.map((w) => [w.queue.name, w.options?.concurrency])).toEqual([
      ['knowledge.index', 4],
    ]);
    expect(work.heavy.map((w) => [w.queue.name, w.options?.concurrency])).toEqual([
      ['knowledge.fill', 4],
    ]);
  });

  it('a KNOWLEDGE_INDEX_CONCURRENCY that is not a whole number from 1 to 32 stops the worker at start', () => {
    for (const value of ['0', '33', '2.5', 'many', ''])
      expect(() => indexConcurrencyOf({ KNOWLEDGE_INDEX_CONCURRENCY: value })).toThrow(
        /KNOWLEDGE_INDEX_CONCURRENCY/,
      );
  });

  it("the worker's knowledge pools have a connection for every index and fill job at once, and room for its queues", () => {
    // Index and fill jobs both run with the night window set to always, each holding a connection
    // while it waits its turn for the generation's lock.
    for (const concurrency of [1, 8, 32])
      expect(knowledgePoolSizeOf(concurrency)).toBeGreaterThanOrEqual(2 * concurrency + 4);
    expect(knowledgePoolSizeOf(1)).toBeGreaterThanOrEqual(10);
  });
});
