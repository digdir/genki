import { describe, expect, it } from 'vitest';
import { plainReasons } from './validation.js';

const path = 'spec.model.primary';

describe('plain reasons for a model that lacks what the strategy needs', () => {
  it('names in bokmål what genki checked and when', () => {
    expect(
      plainReasons([
        {
          path,
          message:
            'model gw/borealis lacks json-schema, which rag-single-shot needs; checked json-schema on 2026-11-19',
        },
      ]),
    ).toContain(
      'Modellen «gw/borealis» mangler strukturerte svar, som oppsettet trenger. Genki sjekket strukturerte svar 19.11.2026.',
    );
  });

  it('reads an unchecked lack as before', () => {
    expect(
      plainReasons([
        { path, message: 'model gw/borealis lacks tools, json-schema, which agent-loop needs' },
      ]),
    ).toContain(
      'Modellen «gw/borealis» mangler verktøybruk og strukturerte svar, som oppsettet trenger.',
    );
  });

  it('translates a long adversarial lacks message in linear time', () => {
    const started = performance.now();
    plainReasons([{ path, message: `model x lacks ${', '.repeat(50_000)}` }]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
