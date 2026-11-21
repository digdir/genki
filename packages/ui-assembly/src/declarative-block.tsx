import type { BlockData } from '@genai/contracts/block-fields';
import type { BlockTemplate, TemplateEvent } from '@genai/contracts/block-template';
import type { BlockState, RefBlockPayload } from '@genai/contracts/blocks';
import { Render } from '@genai/ui-blocks/declarative';
import { useContext, useState } from 'react';
import { BlockHostContext } from './block-events.js';
import { BlockPlaceholder } from './block-placeholder.js';

export interface DeclarativeBlockProps {
  payload: RefBlockPayload;
  data: BlockData;
  state: BlockState;
  settings?: Record<string, boolean | string> | undefined;
  level?: 2 | 3 | undefined;
}

const isTemplate = (value: unknown): value is BlockTemplate =>
  typeof value === 'object' && value !== null && 'root' in value;

/** A declarative edition drawn from its template; only the events it declares reach the host. */
export const DeclarativeBlock = ({
  payload,
  data,
  state,
  settings,
  level,
}: DeclarativeBlockProps) => {
  const host = useContext(BlockHostContext);
  const [notice, setNotice] = useState('');
  if (!isTemplate(payload.template))
    return <BlockPlaceholder blockRef={payload.ref} {...(level ? { level } : {})} />;
  const onEvent = (event: TemplateEvent) => {
    if (!payload.events.includes(event.name)) return;
    if (event.name === 'notify') setNotice(event.text);
    else host.onEvent(event);
  };
  return (
    <div className="uia-declarative-block" data-block-ref={payload.ref}>
      <Render
        template={payload.template}
        data={data}
        texts={payload.texts}
        locale={host.locale}
        props={settings}
        state={state}
        onEvent={onEvent}
      />
      <p role="status" className="uia-declarative-notice">
        {notice}
      </p>
    </div>
  );
};
