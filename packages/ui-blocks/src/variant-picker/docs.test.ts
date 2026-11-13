import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { propsMissingFromPage } from '../docs-props.test-utils.js';

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');
const page = read('../../../../docs/components/variant-picker.html');

describe('the Variant picker page', () => {
  it.each(['VariantOption', 'VariantPickerProps'])('names every field of %s', (name) => {
    expect(propsMissingFromPage(read('VariantPicker.tsx'), name, page)).toEqual([]);
  });
});
