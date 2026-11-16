import { describe, expect, it } from 'vitest';
import { previewScale, previewWidth } from './preview-size';

describe('the size of the preview', () => {
  it('fits the service to the space there is', () => {
    expect(previewScale(previewWidth)).toBe(1);
    expect(previewScale(previewWidth * 0.75)).toBe(0.75);
    expect(previewScale(previewWidth * 1.25)).toBe(1.25);
  });

  it('keeps the zoom readable on very small and very large screens', () => {
    expect(previewScale(200)).toBe(0.5);
    expect(previewScale(previewWidth * 3)).toBe(1.5);
  });

  it('shows the actual size until the space is measured', () => {
    expect(previewScale(0)).toBe(1);
  });
});
