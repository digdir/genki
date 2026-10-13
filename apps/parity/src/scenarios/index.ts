import { mcpScenarios } from './mcp.js';
import { openAiScenarios } from './openai.js';
import { restScenarios } from './rest.js';

export const allScenarios = [...mcpScenarios, ...openAiScenarios, ...restScenarios];
