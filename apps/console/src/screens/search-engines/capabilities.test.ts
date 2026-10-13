import { describe, expect, it } from 'vitest';
import { translator } from '../../i18n';
import { dataLocationText } from './capabilities';

const t = translator('nb');

describe('data location', () => {
  it('reads as a sentence for every location', () => {
    expect(dataLocationText('norway', t)).toBe('Data i Norge');
    expect(dataLocationText('eu', t)).toBe('Data i EU/EØS');
    expect(dataLocationText('global', t)).toBe('Data utenfor EU/EØS');
  });
});
