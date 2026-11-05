import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  documentId,
  formFields,
  formValues,
  inputOf,
  mediaIn,
  nextStep,
  uploadErrors,
  uploadFieldOf,
  withoutMediaPaths,
} from './descriptors';
import type { InputShape } from './types';

const shape: InputShape = {
  kind: 'object',
  fields: {
    prompt: { kind: 'text' },
    size: { kind: 'optional', shape: { kind: 'enum', values: ['small', 'large'] } },
    n: { kind: 'optional', shape: { kind: 'number', integer: true } },
    labels: { kind: 'array', item: { kind: 'plain' } },
    questions: { kind: 'array', item: { kind: 'object', fields: { name: { kind: 'plain' } } } },
  },
};

describe('the next step for a descriptor', () => {
  const uploaded = { source: 'uploaded' as const, contract: null };
  const kind = { builtIn: false, maturity: 'test' as const };

  it("the next step follows the descriptor's status, fixtures and kind maturity", () => {
    expect(nextStep({ ...uploaded, status: 'review', fixtures: 0 }, kind)).toBe('try');
    expect(
      nextStep(
        {
          ...uploaded,
          status: 'review',
          fixtures: 1,
          contract: { suite: 'operation@1', checks: 7, passed: false, failures: [] },
        },
        kind,
      ),
    ).toBe('fix');
    expect(
      nextStep(
        {
          ...uploaded,
          status: 'review',
          fixtures: 1,
          contract: { suite: 'operation@1', checks: 7, passed: true, failures: [] },
        },
        kind,
      ),
    ).toBe('approve');
    expect(nextStep({ ...uploaded, status: 'described', fixtures: 1 }, kind)).toBe('promote');
    expect(
      nextStep(
        { ...uploaded, status: 'described', fixtures: 1 },
        { ...kind, maturity: 'production' },
      ),
    ).toBe('ready');
    expect(
      nextStep(
        { source: 'bundled', status: 'typed', fixtures: 2, contract: null },
        {
          builtIn: true,
          maturity: 'test',
        },
      ),
    ).toBe('ready');
  });
});

describe('uploading a descriptor', () => {
  it('upload errors are placed next to the field they concern', () => {
    expect(uploadFieldOf('id')).toBe('id');
    expect(uploadFieldOf('descriptor')).toBe('descriptor');
    expect(uploadFieldOf('descriptor.status')).toBe('descriptor');
    expect(uploadFieldOf('fixtures.billing')).toBe('fixtures');
    expect(uploadFieldOf('change-reason')).toBe('reason');
    expect(uploadFieldOf('body')).toBe('general');
    const error = new ApiError(422, {
      type: 'about:blank',
      status: 422,
      title: 'The change is invalid',
      errors: [
        { path: 'id', message: 'the descriptor is called a/b@1' },
        {
          path: 'descriptor',
          message: 'api.headers.authorization: credentials come from the endpoint',
        },
      ],
    });
    expect(uploadErrors(error)).toEqual({
      id: ['the descriptor is called a/b@1'],
      descriptor: ['api.headers.authorization: credentials come from the endpoint'],
    });
  });

  it('the name is read from the uploaded document', () => {
    expect(documentId('id: example/classify@1\noperation: classify\n')).toBe('example/classify@1');
    expect(documentId('{"id": "a/b@2"}')).toBe('a/b@2');
    expect(documentId(': not yaml :')).toBeUndefined();
  });
});

describe('the try form', () => {
  it("the try form is built from the descriptor's typed input", () => {
    expect(formFields(shape)).toEqual([
      { path: ['prompt'], name: 'prompt', kind: 'text', optional: false },
      { path: ['size'], name: 'size', kind: 'choice', optional: true, values: ['small', 'large'] },
      { path: ['n'], name: 'n', kind: 'number', optional: true },
      { path: ['labels'], name: 'labels', kind: 'lines', optional: false },
      { path: ['questions'], name: 'questions', kind: 'json', optional: false },
    ]);
    expect(formFields(undefined)).toEqual([
      { path: [], name: 'input', kind: 'json', optional: false },
    ]);
  });

  it('an empty optional field is left out of the input, and a wrong value is an error on its field', () => {
    const fields = formFields(shape);
    expect(
      inputOf(fields, {
        prompt: 'En katt',
        size: '',
        n: '',
        labels: 'billing\nother\n',
        questions: '[{"name":"x"}]',
      }),
    ).toEqual({
      input: { prompt: 'En katt', labels: ['billing', 'other'], questions: [{ name: 'x' }] },
    });
    expect(inputOf(fields, { prompt: '', n: 'tre', labels: 'a', questions: '{' })).toEqual({
      problems: { prompt: 'required', n: 'number', questions: 'json' },
    });
  });

  it('a recorded input fills the form to start from', () => {
    expect(
      formValues(formFields(shape), { prompt: 'Hei', labels: ['a', 'b'], questions: [] }),
    ).toEqual({ prompt: 'Hei', size: '', n: '', labels: 'a\nb', questions: '[]' });
  });

  it("media in a try's answer is shown from the bytes the exchange recorded", () => {
    const ref = {
      kind: 'media',
      mediaType: 'image/png',
      bytes: 68,
      sha256: 'x',
      tenant: '991825827',
      path: 'runs/t/media/1',
    };
    expect(mediaIn({ images: [ref] }, { images: ['AAAA'] })).toEqual([
      { path: 'images[0]', mediaType: 'image/png', bytes: 68, src: 'data:image/png;base64,AAAA' },
    ]);
    expect(withoutMediaPaths({ images: [ref] })).toEqual({
      images: [{ kind: 'media', mediaType: 'image/png', bytes: 68 }],
    });
  });
});
