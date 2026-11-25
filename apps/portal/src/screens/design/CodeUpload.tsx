import { Checkbox, Fieldset, Label, Paragraph } from '@digdir/designsystemet-react';
import { blockFields } from '@genai/contracts/block-fields';
import { blockEvents, type BlockEvent } from '@genai/contracts/blocks';
import { useFormat } from '@genai/i18n/react';
import { useId } from 'react';
import { useT, type PlainKey } from '../../i18n';
import { bundleOf, type Bundle } from './definitions';

const eventKey: Record<BlockEvent, PlainKey> = {
  ask: 'design.eventAsk',
  'open-document': 'design.eventOpenDocument',
  'set-filter': 'design.eventSetFilter',
  'open-page': 'design.eventOpenPage',
  notify: 'design.eventNotify',
  resize: 'design.eventResize',
};

const readable = Object.keys(blockFields);

export const BundleField = ({
  bundle,
  onBundle,
}: {
  bundle: Bundle | undefined;
  onBundle: (bundle: Bundle) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const id = useId();
  return (
    <div className="stack-xs">
      <Label htmlFor={id}>{t('design.bundle')}</Label>
      <input
        id={id}
        type="file"
        accept=".js,text/javascript"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) onBundle(await bundleOf(await file.text()));
        }}
      />
      {bundle ? (
        <Paragraph data-size="sm" className="meta">
          {t('design.bundleFacts', {
            size: f.bytes(bundle.bytes),
            sha: bundle.sha256.slice(0, 12),
          })}
        </Paragraph>
      ) : null}
    </div>
  );
};

/** «Med kode»: the bundle, the fields it reads, its events and source files for the review. */
export const CodeUpload = ({
  bundle,
  reads,
  events,
  sources,
  onBundle,
  onReads,
  onEvents,
  onSources,
}: {
  bundle: Bundle | undefined;
  reads: readonly string[];
  events: readonly BlockEvent[];
  sources: Record<string, string>;
  onBundle: (bundle: Bundle) => void;
  onReads: (reads: string[]) => void;
  onEvents: (events: BlockEvent[]) => void;
  onSources: (sources: Record<string, string>) => void;
}) => {
  const t = useT();
  const sourcesId = useId();
  const toggle = <T extends string>(list: readonly T[], value: T) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  return (
    <div className="stack">
      <BundleField bundle={bundle} onBundle={onBundle} />
      <Fieldset>
        <Fieldset.Legend>{t('design.reads')}</Fieldset.Legend>
        <div className="design-checks">
          {readable.map((path) => (
            <Checkbox
              key={path}
              label={path}
              checked={reads.includes(path)}
              onChange={() => onReads(toggle(reads, path))}
            />
          ))}
        </div>
      </Fieldset>
      <Fieldset>
        <Fieldset.Legend>{t('design.events')}</Fieldset.Legend>
        <div className="design-checks">
          {blockEvents.map((event) => (
            <Checkbox
              key={event}
              label={t(eventKey[event])}
              checked={events.includes(event)}
              onChange={() => onEvents(toggle(events, event))}
            />
          ))}
        </div>
      </Fieldset>
      <div className="stack-xs">
        <Label htmlFor={sourcesId}>{t('design.sourceFiles')}</Label>
        <input
          id={sourcesId}
          type="file"
          multiple
          onChange={async (e) => {
            const files = Array.from(e.target.files ?? []);
            const read = await Promise.all(
              files.map(async (file) => [file.name, await file.text()] as const),
            );
            onSources(Object.fromEntries(read));
          }}
        />
        {Object.keys(sources).length > 0 ? (
          <Paragraph data-size="sm" className="meta">
            {Object.keys(sources).join(', ')}
          </Paragraph>
        ) : null}
      </div>
    </div>
  );
};
