import {
  catalogueBlockIds,
  type DefinitionStore,
  type ServiceDefinition,
  type ValidationError,
} from '@genai/definitions';
import type { ClientStore } from '@genai/identity';

const catalogue: ReadonlySet<string> = new Set(catalogueBlockIds);

const zones = ['primary', 'main', 'secondary'] as const;

const placedBlocks = (spec: Pick<ServiceDefinition, 'spec'>['spec']) =>
  zones.flatMap((zone) =>
    (spec.interface?.layout?.zones[zone] ?? []).map((placed, i) => ({
      block: placed.block,
      path: `spec.interface.layout.zones.${zone}[${i}].block`,
    })),
  );

export const isHostOwnBlock = (block: string) => block.startsWith('x-');

/** Unknown blocks are refused; a host's own `x-` block only while genki's host does not draw the service. */
export const interfaceCatalogueProblems = (
  definition: Pick<ServiceDefinition, 'spec'>,
  hostedByGenki: boolean,
): ValidationError[] =>
  placedBlocks(definition.spec).flatMap(({ block, path }): ValidationError[] => {
    if (isHostOwnBlock(block))
      return hostedByGenki
        ? [
            {
              path,
              message: `${block} is a host's own block, and genki's assistant host draws only catalogue blocks`,
            },
          ]
        : [];
    return catalogue.has(block) ? [] : [{ path, message: `unknown interface block ${block}` }];
  });

export const hostedByGenki = async (clients: ClientStore, tenant: string, service: string) =>
  (await clients.list(tenant)).some(
    (c) => c.definition.spec.service === service && c.definition.spec.hosted === true,
  );

export const hostedServiceProblems = async (
  definitions: DefinitionStore,
  tenant: string,
  service: string,
) => {
  const found = await definitions.get('Service', tenant, service);
  const spec = (found?.definition as Pick<ServiceDefinition, 'spec'> | undefined)?.spec;
  const own = spec ? placedBlocks(spec).filter(({ block }) => isHostOwnBlock(block)) : [];
  return own.length > 0
    ? [
        {
          path: 'spec.hosted',
          message: `the service's interface has a host's own block (${own[0]?.block}), which genki's assistant host does not draw`,
        },
      ]
    : [];
};
