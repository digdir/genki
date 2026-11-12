import { describeContract } from '@genai/plugins/testing';
import {
  blobContract,
  nativeOutputContract,
  fileSystemNativeOutputContractTarget,
  memoryNativeOutputContractTarget,
  fileSystemBlobContractTarget,
  memoryBlobContractTarget,
} from './contract.js';

describeContract('memory', blobContract, memoryBlobContractTarget);

describeContract('filesystem', blobContract, fileSystemBlobContractTarget);

describeContract('memory', nativeOutputContract, memoryNativeOutputContractTarget);

describeContract('filesystem', nativeOutputContract, fileSystemNativeOutputContractTarget);
