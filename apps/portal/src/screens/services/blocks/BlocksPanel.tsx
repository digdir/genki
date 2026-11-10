import {
  Details,
  Divider,
  Fieldset,
  Heading,
  Paragraph,
  Switch,
} from '@digdir/designsystemet-react';
import { SchemaForm, type UiSchema, type Value } from '@genai/schema-forms';
import {
  blockSpec,
  blocksAllowedIn,
  nameKey,
  needKey,
  offerOf,
  optionInForce,
  optionKey,
  optionOfferOf,
  partnersOf,
  placeIn,
  settingsOf,
  settingsSchema,
  turnOff,
  withSetting,
  zoneOf,
  type BlockId,
  type BuilderKey,
  type BuilderState,
  type Need,
  type ServiceFacts,
  type Zone,
} from '@genai/ui-blocks/builder';
import {
  BookIcon,
  BulletListIcon,
  ChatIcon,
  CogIcon,
  FileTextIcon,
  FolderIcon,
  FunnelIcon,
  NotePencilIcon,
  RobotIcon,
} from '@navikt/aksel-icons';
import { Fragment } from 'react';
import type { IconComponent } from '../../../components/Icon';
import { useT, type PlainKey, type T } from '../../../i18n';

/** The catalogue key of a block's name. */
export const blockLabel = (id: BlockId) => nameKey(id);

export const blockIcon: Record<BlockId, IconComponent> = {
  projects: FolderIcon,
  threads: BulletListIcon,
  settings: CogIcon,
  chat: ChatIcon,
  sources: BookIcon,
  notes: NotePencilIcon,
  filter: FunnelIcon,
  approach: RobotIcon,
  'document-view': FileTextIcon,
};

const helpKey = (id: BlockId) => `${nameKey(id)}Help` as BuilderKey;

export const zoneLabel: Record<Zone, PlainKey> = {
  primary: 'builderBlocks.panelLeft',
  main: 'builderBlocks.panelMain',
  secondary: 'builderBlocks.panelRight',
};

const groups: { zone: Zone; legend: PlainKey }[] = [
  { zone: 'primary', legend: 'builderBlocks.groupLeft' },
  { zone: 'main', legend: 'builderBlocks.groupMain' },
  { zone: 'secondary', legend: 'builderBlocks.groupRight' },
];

const reasons = (t: T, needs: readonly Need[]) => needs.map((need) => t(needKey(need))).join(' ');

/** «Valg for …»: the options the draft can back drawn from their schema, the rest with why not. */
const BlockOptions = ({
  id,
  state,
  facts,
  onChange,
}: {
  id: BlockId;
  state: BuilderState;
  facts: ServiceFacts | undefined;
  onChange: (next: BuilderState) => void;
}) => {
  const t = useT();
  const options = blockSpec(id).options;
  const offered = options.filter((o) => optionOfferOf(id, o.id, facts).offered);
  const value = settingsOf(state.layout, id);
  const notes = options.flatMap((option) => {
    const offer = optionOfferOf(id, option.id, facts);
    const label = t(optionKey(id, option.id));
    if (offer.planned) return [t('builderBlocks.planned', { block: label })];
    if (!offer.offered) return [`${label}: ${reasons(t, offer.unmet)}`];
    // On, but with no partner in the layout: it is not in force (V2-0010).
    const partners = (option.needs ?? []).filter((need) => partnersOf(need).length > 0);
    return value[option.id] === true && !optionInForce(state.layout, id, option.id)
      ? [`${label}: ${reasons(t, partners)}`]
      : [];
  });
  const name = t(blockLabel(id));
  return (
    <Details data-color="neutral" className="blocks-options">
      <Details.Summary>{t('builderBlocks.optionsFor', { block: name })}</Details.Summary>
      <Details.Content className="stack-sm">
        {offered.length ? (
          <SchemaForm
            schema={settingsSchema(id) as unknown as UiSchema}
            value={value as Value}
            only={offered.map((o) => o.id)}
            summary={false}
            idPrefix={`blocks-${id}`}
            onChange={(next) =>
              onChange(
                offered.reduce(
                  (s, o) =>
                    next[o.id] === undefined || next[o.id] === value[o.id]
                      ? s
                      : withSetting(s, id, o.id, next[o.id] as boolean | string),
                  state,
                ),
              )
            }
          />
        ) : null}
        {notes.map((note) => (
          <Paragraph key={note} data-size="sm" className="meta">
            {note}
          </Paragraph>
        ))}
      </Details.Content>
    </Details>
  );
};

export const BlocksPanel = ({
  state,
  facts,
  onChange,
}: {
  state: BuilderState;
  /** What the draft can back; without it every built block is offered. */
  facts?: ServiceFacts | undefined;
  onChange: (next: BuilderState) => void;
}) => {
  const t = useT();
  return (
    <div className="blocks-panel">
      <Paragraph data-size="sm">{t('builderBlocks.intro')}</Paragraph>
      {groups.map(({ zone, legend }) => (
        <Fragment key={zone}>
          <Divider />
          <Fieldset className="blocks-group">
            <Fieldset.Legend>
              <Heading level={2} data-size="2xs">
                {t(legend)}
              </Heading>
            </Fieldset.Legend>
            {blocksAllowedIn(zone).map((id) => {
              const at = zoneOf(state.layout, id);
              const offer = offerOf(id, facts);
              const name = t(blockLabel(id));
              const description =
                at !== undefined && at !== zone
                  ? t('builderBlocks.usedIn', { panel: t(zoneLabel[at]).toLowerCase() })
                  : !offer.offered && !offer.planned
                    ? reasons(t, offer.unmet)
                    : t(helpKey(id));
              return (
                <Fragment key={id}>
                  <Switch
                    variant="outline"
                    position="end"
                    label={offer.planned ? t('builderBlocks.planned', { block: name }) : name}
                    description={description}
                    checked={at === zone}
                    disabled={!offer.offered && at !== zone}
                    onChange={() =>
                      onChange(at === zone ? turnOff(state, id) : placeIn(state, id, zone))
                    }
                  />
                  {at === zone && blockSpec(id).options.length > 0 ? (
                    <BlockOptions id={id} state={state} facts={facts} onChange={onChange} />
                  ) : null}
                </Fragment>
              );
            })}
          </Fieldset>
        </Fragment>
      ))}
    </div>
  );
};
