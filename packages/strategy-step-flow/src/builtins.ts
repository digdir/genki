import { BlockRegistry } from './blocks.js';
import { agentBlock, approvalBlock, routeBlock, templateBlock } from './blocks/control.js';
import { documentsBlock, readDocumentBlock } from './blocks/documents.js';
import { facetsBlock } from './blocks/facets.js';
import { classifyBlock, extractBlock, modelBlock } from './blocks/model.js';
import {
  answerBlock,
  evidenceGateBlock,
  overviewFinalizeBlock,
  rerankBlock,
  retrieveBlock,
  synthesizeBlock,
} from './blocks/retrieval.js';
import { tableBlock } from './blocks/table.js';
import { toolBlock } from './blocks/tools.js';

export const builtinBlocks = () =>
  new BlockRegistry()
    .register(modelBlock)
    .register(extractBlock)
    .register(classifyBlock)
    .register(retrieveBlock)
    .register(facetsBlock)
    .register(rerankBlock)
    .register(synthesizeBlock)
    .register(evidenceGateBlock)
    .register(overviewFinalizeBlock)
    .register(answerBlock)
    .register(templateBlock)
    .register(routeBlock)
    .register(approvalBlock)
    .register(agentBlock)
    .register(documentsBlock)
    .register(readDocumentBlock)
    .register(tableBlock)
    .register(toolBlock);
