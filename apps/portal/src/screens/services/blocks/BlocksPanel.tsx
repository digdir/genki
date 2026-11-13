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
  moveTo,
  nameKey,
  needKey,
  offerOf,
  optionInForce,
  optionKey,
  optionOfferOf,
  partnersOf,
  placeIn,
  placesHelpKey,
  settingsOf,
  settingsSchema,
  turnOff,
  withSetting,
  zonesOf,
  type BlockId,
  type BuilderKey,
  type BuilderState,
  type Need,
  type ServiceFacts,
  type Zone,
} from '@genai/ui-blocks/builder';
import { Fragment } from 'react';
import { useT, type PlainKey, type T } from '../../../i18n';

/** The catalogue key of a block's name. */
export const blockLabel = (id: BlockId) => nameKey(id);

const helpKey = (id: BlockId) => `${nameKey(id)}Help` as BuilderKey;

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The block's options schema with the catalogue's words in place of its keys. */
const wordedSchema = (id: BlockId, t: T): UiSchema => {
  const schema = settingsSchema(id);
  return {
    ...schema,
    properties: Object.fromEntries(
      blockSpec(id).options.map((option) => {
        const key = optionKey(id, option.id);
        return [
          option.id,
          {
            ...schema.properties[option.id],
            'x-label': t(key),
            'x-help': t(`${key}Help` as BuilderKey),
            ...(option.kind === 'choice'
              ? {
                  'x-enumLabels': Object.fromEntries(
                    option.choices.map((choice) => [
                      choice,
                      t(`${key}${capital(choice)}` as BuilderKey),
                    ]),
                  ),
                }
              : {}),
          },
        ];
      }),
    ),
  } as unknown as UiSchema;
};

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

/** «Valg for …»: the options the draft backs, drawn from their schema; the rest with why not. */
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
    // On, but with no partner in the layout: it is not in force.
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
            schema={wordedSchema(id, t)}
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
              const spec = blockSpec(id);
              const at = zonesOf(state.layout, id);
              const here = at.includes(zone);
              // Where else it stands; a block that may stand in both its zones is turned on in each.
              const elsewhere = at.find((other) => other !== zone);
              const offer = offerOf(id, facts);
              const name = t(blockLabel(id));
              const description =
                elsewhere !== undefined && !here && !spec.both
                  ? t('builderBlocks.usedIn', { panel: t(zoneLabel[elsewhere]).toLowerCase() })
                  : !offer.offered && !offer.planned
                    ? reasons(t, offer.unmet)
                    : t(spec.both ? placesHelpKey(id) : helpKey(id));
              const toggled = () =>
                here
                  ? elsewhere
                    ? moveTo(state, id, elsewhere)
                    : turnOff(state, id)
                  : elsewhere && spec.both
                    ? moveTo(state, id, 'both')
                    : placeIn(state, id, zone);
              return (
                <Fragment key={id}>
                  <Switch
                    variant="outline"
                    position="end"
                    label={offer.planned ? t('builderBlocks.planned', { block: name }) : name}
                    description={description}
                    checked={here}
                    disabled={!offer.offered && !here}
                    onChange={() => onChange(toggled())}
                  />
                  {here && at[0] === zone && spec.options.length > 0 ? (
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
