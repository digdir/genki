import { isBuiltInBlockId } from '@genai/contracts';
import {
  parseBlockRef,
  type BlockDefinition,
  type DefinitionStore,
  type ServiceDefinition,
  type ValidationError,
} from '@genai/definitions';
import type { ClientStore } from '@genai/identity';

const zones = ['primary', 'main', 'secondary'] as const;

const placedBlocks = (spec: Pick<ServiceDefinition, 'spec'>['spec']) =>
  zones.flatMap((zone) =>
    (spec.interface?.layout?.zones[zone] ?? []).map((placed, i) => ({
      block: placed.block,
      ref: placed.ref,
      path: `spec.interface.layout.zones.${zone}[${i}].block`,
      refPath: `spec.interface.layout.zones.${zone}[${i}].ref`,
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
    return isBuiltInBlockId(block) ? [] : [{ path, message: `unknown interface block ${block}` }];
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

const specOf = (definition: unknown) => (definition as BlockDefinition).spec;

/** Each `ref` must name a published version of a Block the service's organisation may use, drawn as its `block`. */
export const blockRefProblems = async (
  store: Pick<DefinitionStore, 'versions'>,
  definition: Pick<ServiceDefinition, 'metadata' | 'spec'>,
): Promise<ValidationError[]> => {
  const problems: ValidationError[] = [];
  for (const { block, ref, refPath: path } of placedBlocks(definition.spec)) {
    const target = ref === undefined ? undefined : parseBlockRef(ref);
    if (!ref || !target) continue;
    const { publisher, id, version } = target;
    const own = publisher === definition.metadata.tenant;
    const usable = (await store.versions('Block', publisher, id)).filter(
      (v) => own || specOf(v.definition).sharing === 'everyone',
    );
    const pinned = usable.find((v) => v.version === version);
    if (usable.length === 0)
      problems.push({
        path,
        message: `no published block ${publisher}/${id} that this organisation may use`,
      });
    else if (!pinned)
      problems.push({
        path,
        message: `block ${publisher}/${id} has no version ${version} that this organisation may use`,
      });
    else {
      const spec = specOf(pinned.definition);
      const drawn = spec.tier === 'built-in' ? spec.builtIn : undefined;
      if (drawn !== block)
        problems.push({
          path,
          message: drawn
            ? `${ref} is drawn as ${drawn}, so its block must be ${drawn}`
            : `${ref} is a ${spec.tier} block, which no host draws yet`,
        });
    }
  }
  return problems;
};
