import { describe, expect, it } from 'vitest';
import { defaultOutput, structuredContent } from '@genai/adapter-mcp';
import { call, result, run } from '@genai/strategy-agent-loop/harness.test-utils';
import { citationsResolveByDocument } from './checks.js';
import type { Captured, JsonValue } from './types.js';

const overMcp = (parts: Parameters<typeof defaultOutput>[0]): Captured => {
  const { text, structured } = defaultOutput(parts);
  return {
    status: 200,
    headers: {},
    body: {
      result: {
        isError: false,
        content: [{ type: 'text', text }],
        structuredContent: structuredContent(structured, 'conversation') as JsonValue,
      },
    },
  };
};

describe('an agent answer over MCP', () => {
  it('resolves each [N] to the Nth document when it cites only some of what it read', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev Digdir 2025'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2', 'c3'] })]),
          ],
          synth: [() => 'Digdir skal digitalisere [3] og samordne [3][2].'],
        },
      },
    });

    expect(citationsResolveByDocument(overMcp(out.parts))).toEqual([]);
  });
});
