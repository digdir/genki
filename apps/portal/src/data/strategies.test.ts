import { beforeEach, describe, expect, it } from 'vitest';
import { translator } from '../i18n';
import { platformStrategies } from '../mock/strategies';
import { registerStrategies, strategyFor, takesOf, writePath } from './strategies';

beforeEach(() => registerStrategies(platformStrategies));

describe('the strategies come from the API catalogue', () => {
  it('shows the name the API gives, in bokmål and in English', () => {
    expect(strategyFor('remote-agent', translator('nb'))?.name).toBe('Egen motor');
    expect(strategyFor('remote-agent', translator('en'))?.name).toBe('Own engine');
  });

  it('knows what each strategy takes, and nothing before the catalogue is loaded', () => {
    expect(takesOf('single-call')).toEqual({ instructions: 'required', examples: 'optional' });
    registerStrategies([]);

    expect(strategyFor('single-call')).toBeUndefined();
    expect(takesOf('single-call')).toEqual({ instructions: 'no', examples: 'no' });
  });
});

describe('the paths the settings form writes', () => {
  it('writes nested values and removes emptied branches', () => {
    const url = writePath({}, ['endpoint', 'url'], 'https://agent.example.no/turn');
    const residency = writePath(url, ['endpoint', 'residency'], 'eu');

    expect(residency).toEqual({
      endpoint: { url: 'https://agent.example.no/turn', residency: 'eu' },
    });
    expect(writePath(writePath(url, ['endpoint', 'url'], undefined), [], 1)).toEqual({});
  });
});
