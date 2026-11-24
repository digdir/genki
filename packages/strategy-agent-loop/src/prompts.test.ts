import { describe, expect, it } from 'vitest';
import { searchPromptSections, toolsOnlyPromptSections } from './prompts.js';

// Opus 5.5 refuses a turn whose prompt asks it to write out its reasoning
// (stop_reason refusal, category reasoning_extraction), with 0 output tokens.
const asksForReasoning = /\b(reasoning|explain|why)\b/i;

describe('built-in prompt sections', () => {
  it.each([
    ['search', searchPromptSections],
    ['tools-only', toolsOnlyPromptSections],
  ])('the %s sections never ask the model to explain or include its reasoning', (_, sections) => {
    for (const section of sections) expect(section.text).not.toMatch(asksForReasoning);
  });
});
