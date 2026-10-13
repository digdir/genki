import { describeContract } from '@genai/plugins/testing';
import { blockRef } from './blocks.js';
import { builtinBlocks } from './builtins.js';
import { stepBlockContract } from './contract.js';

const registry = builtinBlocks();

for (const ref of registry.refs()) {
  const block = registry.get(ref);
  if (block) describeContract(blockRef(block), stepBlockContract, async () => ({ subject: block }));
}
