import { describe, expect, it } from 'vitest';
import { asServiceDefinition, keepSharing } from './service-definition';

const service = (availableTo?: '*' | string[]) =>
  asServiceDefinition({
    metadata: { tenant: '991825827', id: 'klarsprak' },
    spec: { purpose: 'Klart språk', ...(availableTo ? { availableTo } : {}) },
  });

describe('keepSharing', () => {
  it('keeps who the service is shared with now when an older version is restored', () => {
    expect(keepSharing(service('*'), service()).spec).not.toHaveProperty('availableTo');
    expect(keepSharing(service(), service(['999888777'])).spec.availableTo).toEqual(['999888777']);
    expect(keepSharing(service(['999888777']), service('*')).spec.availableTo).toBe('*');
  });
});
