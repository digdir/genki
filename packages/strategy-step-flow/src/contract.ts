import { check, checkEqual, skipped, type ContractSuite } from '@genai/plugins';
import { z } from 'zod';
import { blockRef, type Block, type BlockContext } from './blocks.js';

export const stepBlockContractVersion = 'step-block@1';

const schemaOf = (schema: z.ZodType, what: string) => {
  try {
    return z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${what} has no JSON Schema: ${error instanceof Error ? error.message : ''}`, {
      cause: error,
    });
  }
};

export const stepBlockContract: ContractSuite<Block> = {
  contract: stepBlockContractVersion,
  checks: [
    {
      name: 'the block is named name@version and described',
      run: async (block) => {
        check(/^[a-z][a-z0-9-]*@\d+(\.\d+)*$/.test(blockRef(block)), `ref ${blockRef(block)}`);
        check(block.description.trim().length > 0, 'the block has a description');
      },
    },
    {
      name: 'input, params and output have JSON Schemas for editors and the API',
      run: async (block) => {
        for (const [what, schema] of [
          ['input', block.input],
          ['params', block.params],
          ['output', block.output],
        ] as const)
          check(typeof schemaOf(schema, what) === 'object', `${what} schema`);
      },
    },
    {
      name: 'params of the wrong type are refused before the block runs',
      run: async (block) => {
        const json = schemaOf(block.params, 'params');
        if (json.type !== 'object') return skipped;
        checkEqual(block.params.safeParse(42).success, false, 'params 42');
        checkEqual(block.params.safeParse('tekst').success, false, 'params "tekst"');
      },
    },
    {
      name: 'run is a lazy async generator that does no work before it is iterated',
      run: async (block) => {
        let touched = false;
        const trap = new Proxy({} as BlockContext, {
          get: () => {
            touched = true;
            return undefined;
          },
        });
        const iterator = block.run(trap, undefined, undefined);
        check(typeof iterator[Symbol.asyncIterator] === 'function', 'run returns an iterator');
        check(!touched, 'the block read its context before it was iterated');
        await iterator.return(undefined);
      },
    },
  ],
};
