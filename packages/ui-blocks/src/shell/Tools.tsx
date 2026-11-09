import { Field, Heading, Label, Select } from '@digdir/designsystemet-react';
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { toolMode } from '../builder/layout.js';
import { classes } from '../dom.js';
import { useT } from '../i18n.js';

export interface ShellTool {
  /** Stable across renders: the tool's state is kept by it. */
  id: string;
  /** Its name, on the heading, the tab or the dropdown's option: «Kilder». */
  label: string;
  content: ReactNode;
}

export interface ShellToolsProps {
  /** In the order they are offered. */
  tools: readonly ShellTool[];
  /** The tool shown, by its id. Without it, the block keeps its own, the first to begin with. */
  active?: string | undefined;
  /** The reader chose another tool. */
  onChange?: ((id: string) => void) | undefined;
  /** The heading's level when there is one tool, 2 by default. */
  headingLevel?: 2 | 3 | 4 | undefined;
  /**
   * The panel's pinned region (`ShellPanel.pinnedRef`), to draw the heading, tabs or dropdown in,
   * so they stay while the tool scrolls. `null` until the region is there: nothing is drawn.
   * Without it, the switcher stands over the tool.
   */
  pinIn?: Element | null | undefined;
  className?: string | undefined;
}

/**
 * The tools in the secondary panel, offered by how many there are, as the design's tool rule
 * says: one gets a heading, two get tabs, three or more a dropdown (board 3, SP10; #168). Every
 * tool stays mounted while hidden, so a search or a scroll position in one survives a visit to
 * another. The tool's own heading is the app's to leave out: here the switcher names it.
 */
export const ShellTools = ({
  tools,
  active,
  onChange,
  headingLevel = 2,
  pinIn,
  className,
}: ShellToolsProps) => {
  const t = useT();
  const id = useId();
  const [own, setOwn] = useState<string>();
  const chosen = active ?? own;
  const current = tools.find((tool) => tool.id === chosen) ?? tools[0];
  const tabs = useRef(new Map<string, HTMLButtonElement | null>());
  const mode = toolMode(tools.length);
  if (mode === 'none' || !current) return null;

  const choose = (next: string) => {
    setOwn(next);
    if (next !== current.id) onChange?.(next);
  };
  const panelId = (tool: ShellTool) => `${id}-panel-${tool.id}`;
  const tabId = (tool: ShellTool) => `${id}-tab-${tool.id}`;

  // The arrows move between the tabs and choose as they go, Home and End go to the ends: the
  // tabs pattern with automatic activation, one tab stop for the list.
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const at = tools.findIndex((tool) => tool.id === current.id);
    const to =
      event.key === 'ArrowRight'
        ? (at + 1) % tools.length
        : event.key === 'ArrowLeft'
          ? (at - 1 + tools.length) % tools.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tools.length - 1
              : undefined;
    if (to === undefined) return;
    event.preventDefault();
    const next = tools[to];
    if (!next) return;
    choose(next.id);
    tabs.current.get(next.id)?.focus();
  };

  const panels = tools.map((tool) => (
    <div
      className="uib-shell-tool"
      hidden={tool.id !== current.id || undefined}
      id={panelId(tool)}
      key={tool.id}
      {...(mode === 'tabs'
        ? { role: 'tabpanel', 'aria-labelledby': tabId(tool) }
        : mode === 'dropdown'
          ? { role: 'region', 'aria-label': tool.label }
          : {})}
    >
      {tool.content}
    </div>
  ));

  const switcher =
    mode === 'heading' ? (
      <Heading className="uib-shell-tools-heading" data-size="xs" level={headingLevel}>
        {current.label}
      </Heading>
    ) : mode === 'tabs' ? (
      <div aria-label={t('shell.tools')} className="uib-shell-tools-tabs" role="tablist">
        {tools.map((tool) => {
          const selected = tool.id === current.id;
          return (
            <button
              aria-controls={panelId(tool)}
              aria-selected={selected}
              className="uib-shell-tools-tab ds-focus"
              id={tabId(tool)}
              key={tool.id}
              onClick={() => choose(tool.id)}
              onKeyDown={onTabKey}
              ref={(element) => {
                tabs.current.set(tool.id, element);
              }}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {tool.label}
            </button>
          );
        })}
      </div>
    ) : (
      <Field className="uib-shell-tools-choice">
        <Label className="ds-sr-only">{t('shell.tools')}</Label>
        <Select value={current.id} onChange={(event) => choose(event.currentTarget.value)}>
          {tools.map((tool) => (
            <Select.Option key={tool.id} value={tool.id}>
              {tool.label}
            </Select.Option>
          ))}
        </Select>
      </Field>
    );

  return (
    <div className={classes('uib-shell-tools', className)} data-mode={mode}>
      {pinIn === undefined ? switcher : pinIn && createPortal(switcher, pinIn)}
      {panels}
    </div>
  );
};
