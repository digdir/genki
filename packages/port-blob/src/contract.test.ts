import { describeContract } from '@genai/plugins/testing';
import {
  blobContract,
  conversionContract,
  fileSystemConversionContractTarget,
  memoryConversionContractTarget,
  fileSystemBlobContractTarget,
  memoryBlobContractTarget,
} from './contract.js';

describeContract('memory', blobContract, memoryBlobContractTarget);

describeContract('filesystem', blobContract, fileSystemBlobContractTarget);

describeContract('memory', conversionContract, memoryConversionContractTarget);

describeContract('filesystem', conversionContract, fileSystemConversionContractTarget);
