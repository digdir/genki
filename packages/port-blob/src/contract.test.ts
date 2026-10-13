import { describeContract } from '@genai/plugins/testing';
import {
  blobContract,
  fileSystemBlobContractTarget,
  memoryBlobContractTarget,
} from './contract.js';

describeContract('memory', blobContract, memoryBlobContractTarget);

describeContract('filesystem', blobContract, fileSystemBlobContractTarget);
