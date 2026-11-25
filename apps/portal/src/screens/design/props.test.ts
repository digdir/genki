import { describe, expect, it } from 'vitest';
import { contrast, parseColor } from './contrast';
import { defaultsOf, labelOf, missingFields, withDefaults } from './props';

const level = {
  type: 'string',
  enum: ['standard', 'detailed'],
  default: 'standard',
  'x-label': 'builder.approachLevel',
};

describe('a block’s props in Block Studio', () => {
  it('starts each prop at its default, a switch off and a choice at its first', () => {
    expect(
      defaultsOf({ level, icon: { type: 'boolean' }, sep: { type: 'string', enum: ['a', 'b'] } }),
    ).toEqual({ level: 'standard', icon: false, sep: 'a' });
  });

  it('names a prop and its choices in genki’s own words', () => {
    expect(labelOf('level', level, 'nb')).toBe('Detaljnivå');
    expect(labelOf('level', level, 'nb', 'detailed')).toBe('Detaljert');
    expect(labelOf('level', level, 'en', 'detailed')).toBe('Detailed');
    expect(labelOf('copy', { title: 'Kopier-knapp' }, 'nb')).toBe('Kopier-knapp');
  });

  it('saves the chosen values as the defaults of the next edition', () => {
    expect(withDefaults({ level }, { level: 'detailed' })).toEqual({
      level: { ...level, default: 'detailed' },
    });
  });

  it('reads the fields genki does not send from the check’s messages', () => {
    expect(
      missingFields([
        { message: 'sources.registerId is not a field a block may read' },
        { message: 'sources.registerId is not a field a block may read' },
        { message: 'mangler bokmål' },
      ]),
    ).toEqual(['sources.registerId']);
  });

  it('reads a long message without a field in linear time', () => {
    const started = performance.now();
    missingFields([{ message: `${'a'.repeat(50_000)} is not a field a block may rea` }]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('the contrast Block Studio measures', () => {
  it('is 21 to 1 for black on white and 1 to 1 for a colour on itself', () => {
    const black = parseColor('rgb(0, 0, 0)');
    const white = parseColor('rgba(255, 255, 255, 1)');
    expect(black && white ? contrast(black, white) : 0).toBeCloseTo(21, 5);
    expect(white ? contrast(white, white) : 0).toBe(1);
  });
});
