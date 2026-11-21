import { isBuiltInBlockId, isRefBlockId } from '@genai/contracts';
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
      zone,
      block: placed.block,
      ref: placed.ref,
      settings: placed.settings,
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
  placedBlocks(definition.spec).flatMap(({ block, ref, path }): ValidationError[] => {
    if (isRefBlockId(block))
      return ref ? [] : [{ path, message: 'ref as a block needs a ref to the block it draws' }];
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

const settingProblem = (
  ref: string,
  key: string,
  value: boolean | string,
  props: BlockDefinition['spec']['props'],
): string | undefined => {
  const prop = props?.properties[key];
  if (!prop || !Object.hasOwn(props.properties, key)) return `${ref} has no setting ${key}`;
  if (prop.type === 'boolean')
    return typeof value === 'boolean'
      ? undefined
      : `setting ${key} of ${ref} must be true or false`;
  if (typeof value !== 'string') return `setting ${key} of ${ref} must be a text`;
  const allowed = Array.isArray(prop.enum) ? prop.enum.map(String) : undefined;
  return allowed && !allowed.includes(value)
    ? `setting ${key} of ${ref} must be one of ${allowed.join(', ')}`
    : undefined;
};

/** The problems of one ref against the edition it pins: how it is drawn, where it stands and its settings. */
const editionProblems = (
  placed: ReturnType<typeof placedBlocks>[number],
  ref: string,
  spec: BlockDefinition['spec'],
): ValidationError[] => {
  const { block, zone, settings, refPath: path } = placed;
  const problems: ValidationError[] = [];
  const drawn = spec.tier === 'built-in' ? spec.builtIn : 'ref';
  if (drawn !== block)
    problems.push({
      path,
      message:
        spec.tier === 'built-in'
          ? `${ref} is drawn as ${drawn}, so its block must be ${drawn}`
          : `${ref} is a ${spec.tier} block, so its block must be ref`,
    });
  if (!(spec.zones as readonly string[]).includes(zone))
    problems.push({
      path,
      message: `${ref} cannot stand in ${zone}; it may stand in ${spec.zones.join(', ')}`,
    });
  for (const [key, value] of Object.entries(settings ?? {})) {
    const message = settingProblem(ref, key, value, spec.props);
    if (message)
      problems.push({ path: `${path.slice(0, -'.ref'.length)}.settings.${key}`, message });
  }
  return problems;
};

/** Each `ref` must name a published version of a Block the service's organisation may use, placed as that version allows. */
export const blockRefProblems = async (
  store: Pick<DefinitionStore, 'versions'>,
  definition: Pick<ServiceDefinition, 'metadata' | 'spec'>,
): Promise<ValidationError[]> => {
  const problems: ValidationError[] = [];
  for (const placed of placedBlocks(definition.spec)) {
    const { ref, refPath: path } = placed;
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
    else problems.push(...editionProblems(placed, ref, specOf(pinned.definition)));
  }
  return problems;
};
