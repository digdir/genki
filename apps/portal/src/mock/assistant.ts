import type {
  AssistantTurn,
  AssistantTurnRequest,
  AssistantUnavailableReason,
} from '../api/assistant';
import {
  answeredTurn,
  assistantUserMessages,
  chatTurn,
  exampleAssistantTurn,
  type AssistantState,
} from '../data/services';
import type { MockHandler } from '../mock';

export interface AssistantMockOptions {
  status?: 'unavailable' | 'budget_exhausted' | 'disabled' | 'server_error';
  reason?: AssistantUnavailableReason;
  turns?: AssistantTurnRequest[];
  reply?: (draft: Record<string, unknown>) => AssistantTurn;
}

const turnRoute = /^\/tenants\/([^/]+)\/services\/([^/]+)\/assistant\/turns$/;
const asDraft = (definition: AssistantTurnRequest['draft']['definition']) =>
  typeof definition === 'string' ? {} : definition;

const stateFor = (message: string) => {
  const wanted = message.trim().toLowerCase();
  return (Object.entries(assistantUserMessages) as [AssistantState, string][]).find(
    ([, text]) => text.toLowerCase() === wanted,
  )?.[0];
};

export const scriptedTurn = (body: AssistantTurnRequest): AssistantTurn => {
  const draft = asDraft(body.draft.definition);
  if (body.intent === 'improve-instructions')
    return exampleAssistantTurn('forbedre-instruksjoner', draft) as AssistantTurn;
  if (body.intent === 'suggest-test-cases')
    return exampleAssistantTurn('testforslag', draft) as AssistantTurn;
  if (body.answers && Object.keys(body.answers).length) return answeredTurn(draft, body.answers);
  const state = stateFor(body.message);
  return (state && exampleAssistantTurn(state, draft)) || chatTurn(draft, body.message);
};

export const assistantMock =
  (options: AssistantMockOptions = {}): MockHandler =>
  (request) => {
    const turn = turnRoute.exec(request.path);
    if (turn && request.method === 'POST') {
      const body = request.body<AssistantTurnRequest>();
      options.turns?.push(body);
      if (options.status === 'disabled')
        return request.json(
          { type: 'about:blank', title: 'Byggeassistenten er slått av', status: 409 },
          409,
        );
      if (options.status === 'server_error')
        return request.json({ type: 'about:blank', title: 'Bad Gateway', status: 502 }, 502);
      if (options.status) {
        const draft = asDraft(body.draft.definition);
        const answer = exampleAssistantTurn(
          options.status === 'unavailable' ? 'utilgjengelig' : 'budsjett-brukt',
          draft,
        );
        return request.json(
          options.reason && answer ? { ...answer, reason: options.reason } : answer,
        );
      }
      if (options.reply) return request.json(options.reply(asDraft(body.draft.definition)));
      return request.json(scriptedTurn(body));
    }
    return undefined;
  };
