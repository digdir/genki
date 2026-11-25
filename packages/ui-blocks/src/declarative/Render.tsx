import type { BlockData } from '@genai/contracts/block-fields';
import {
  templateDrawn,
  templateLimits,
  type BlockTemplate,
  type TemplateEvent,
} from '@genai/contracts/block-template';
import type { BlockState, BlockTexts } from '@genai/contracts/blocks';
import { Node } from './elements.js';
import type { BlockLocale } from './text.js';

export interface RenderProps {
  template: BlockTemplate;
  data: BlockData;
  texts?: BlockTexts | undefined;
  locale: BlockLocale;
  props?: Readonly<Record<string, boolean | string>> | undefined;
  state: BlockState;
  onEvent: (event: TemplateEvent) => void;
}

/** A declarative block drawn from its template: Designsystemet components, data only as text. */
export const Render = ({ template, data, texts, locale, props, state, onEvent }: RenderProps) => (
  <div className="uib-declarative">
    {templateDrawn(template) <= templateLimits.drawn && (
      <Node
        node={template.states?.[state] ?? template.root}
        scope={{ data: data as Record<string, unknown>, props: props ?? {}, items: new Map() }}
        ctx={{ texts, locale, state, onEvent }}
        depth={1}
      />
    )}
  </div>
);
