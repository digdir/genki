import {
  Alert,
  Button,
  Card,
  Details,
  Divider,
  Heading,
  Link,
  List,
  Paragraph,
  Table,
  Tag,
} from '@digdir/designsystemet-react';
import {
  templateLimits,
  templatePagePattern,
  type TemplateAction,
  type TemplateCondition,
  type TemplateEvent,
  type TemplateNode,
  type TemplateText,
} from '@genai/contracts/block-template';
import type { BlockState, BlockTexts } from '@genai/contracts/blocks';
import type { ReactNode } from 'react';
import { templateIconComponents } from './icons.js';
import { hrefOf, listAt, textOf, valueAt, type BlockLocale, type Scope } from './text.js';

export interface DrawContext {
  texts: BlockTexts | undefined;
  locale: BlockLocale;
  state: BlockState;
  onEvent: (event: TemplateEvent) => void;
}

const withItem = (scope: Scope, alias: string, item: unknown): Scope => ({
  ...scope,
  items: new Map(scope.items).set(alias, item),
});

const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0);

const holds = (
  condition: TemplateCondition,
  scope: Scope,
  state: BlockState,
  depth = 0,
): boolean => {
  if (depth > templateLimits.conditionDepth) return false;
  if ('not' in condition) return !holds(condition.not, scope, state, depth + 1);
  if ('exists' in condition) return !isEmpty(valueAt(condition.exists, scope));
  if ('empty' in condition) return isEmpty(valueAt(condition.empty, scope));
  if ('equals' in condition) return valueAt(condition.equals[0], scope) === condition.equals[1];
  return condition.state === state;
};

const itemsOf = (path: string, max: number | undefined, scope: Scope) =>
  listAt(path, scope).slice(0, Math.min(max ?? templateLimits.eachDefault, templateLimits.eachMax));

const eventOf = (
  action: TemplateAction,
  scope: Scope,
  ctx: DrawContext,
): TemplateEvent | undefined => {
  const text = (t: TemplateText) => textOf(t, scope, ctx.texts, ctx.locale);
  switch (action.name) {
    case 'ask': {
      const question = text(action.question).trim();
      return question ? { name: 'ask', question } : undefined;
    }
    case 'notify':
      return { name: 'notify', text: text(action.text) };
    case 'open-page':
      return templatePagePattern.test(action.page)
        ? { name: 'open-page', page: action.page }
        : undefined;
    case 'open-document': {
      const index = valueAt(action.source, scope);
      return typeof index === 'number' ? { name: 'open-document', index } : undefined;
    }
    case 'set-filter': {
      const values =
        typeof action.values === 'string' ? listAt(action.values, scope) : action.values;
      return {
        name: 'set-filter',
        field: action.field,
        values: values.filter((v): v is string => typeof v === 'string'),
      };
    }
  }
};

const gapOf = (gap: string | undefined) => (gap && gap !== 'md' ? { 'data-gap': gap } : {});

/** One node of a template, drawn with its Designsystemet component. */
export const Node = ({
  node,
  scope,
  ctx,
  depth,
}: {
  node: TemplateNode;
  scope: Scope;
  ctx: DrawContext;
  depth: number;
}): ReactNode => {
  if (depth > templateLimits.depth) return null;
  const text = (t: TemplateText) => textOf(t, scope, ctx.texts, ctx.locale);
  const children = (nodes: TemplateNode[], inner: Scope = scope) =>
    nodes.map((child, i) => (
      <Node key={i} node={child} scope={inner} ctx={ctx} depth={depth + 1} />
    ));
  switch (node.type) {
    case 'stack':
      return (
        <div className="uib-declarative-stack" {...gapOf(node.gap)}>
          {children(node.children)}
        </div>
      );
    case 'row':
      return (
        <div
          className="uib-declarative-row"
          {...gapOf(node.gap)}
          {...(node.wrap ? { 'data-wrap': 'true' } : {})}
          {...(node.align ? { 'data-align': node.align } : {})}
        >
          {children(node.children)}
        </div>
      );
    case 'card':
      return <Card data-variant={node.variant ?? 'default'}>{children(node.children)}</Card>;
    case 'details':
      return (
        <Details {...(node.open ? { defaultOpen: true } : {})}>
          <Details.Summary>{text(node.summary)}</Details.Summary>
          <Details.Content>{children(node.children)}</Details.Content>
        </Details>
      );
    case 'heading':
      return (
        <Heading level={node.level} data-size={node.size ?? 'xs'}>
          {text(node.text)}
        </Heading>
      );
    case 'paragraph':
      return (
        <Paragraph
          data-size={node.size ?? 'md'}
          {...(node.variant === 'subtle' ? { className: 'uib-declarative-subtle' } : {})}
        >
          {text(node.text)}
        </Paragraph>
      );
    case 'list': {
      const Of = node.ordered ? List.Ordered : List.Unordered;
      return (
        <Of>
          {node.items.flatMap((item, i) =>
            item.type === 'each'
              ? itemsOf(item.of, item.max, scope).map((one, j) => (
                  <List.Item key={`${i}-${j}`}>
                    {children(item.children, withItem(scope, item.as, one))}
                  </List.Item>
                ))
              : [<List.Item key={i}>{children([item])}</List.Item>],
          )}
        </Of>
      );
    }
    case 'link': {
      const href = hrefOf(node.href, scope);
      const label = text(node.text);
      if (!href) return <span>{label}</span>;
      return href.startsWith('https://') ? (
        <Link href={href} rel="noopener noreferrer" target="_blank">
          {label}
        </Link>
      ) : (
        <Link href={href}>{label}</Link>
      );
    }
    case 'button':
      return (
        <Button
          type="button"
          variant={node.variant ?? 'secondary'}
          data-size="sm"
          onClick={() => {
            const event = eventOf(node.event, scope, ctx);
            if (event) ctx.onEvent(event);
          }}
        >
          {text(node.text)}
        </Button>
      );
    case 'tag':
      return <Tag data-color={node.color ?? 'neutral'}>{text(node.text)}</Tag>;
    case 'alert':
      return <Alert data-color={node.color}>{text(node.text)}</Alert>;
    case 'divider':
      return <Divider />;
    case 'icon': {
      const Icon = templateIconComponents[node.name];
      if (!Icon) return null;
      const label = node.label ? text(node.label) : '';
      return label ? (
        <Icon className="uib-declarative-icon" title={label} role="img" aria-label={label} />
      ) : (
        <Icon className="uib-declarative-icon" aria-hidden />
      );
    }
    case 'table':
      return (
        <Table data-size="sm">
          <Table.Head>
            <Table.Row>
              {node.columns.map((column, i) => (
                <Table.HeaderCell key={i}>{text(column.header)}</Table.HeaderCell>
              ))}
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {itemsOf(node.rows, node.max, scope).map((row, i) => (
              <Table.Row key={i}>
                {node.columns.map((column, j) => (
                  <Table.Cell key={j}>
                    {children([column.cell], withItem(scope, node.as, row))}
                  </Table.Cell>
                ))}
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      );
    case 'keyValue':
      return (
        <dl className="uib-declarative-key-value">
          {node.items.map((item, i) => (
            <div key={i}>
              <dt>{text(item.key)}</dt>
              <dd>{text(item.value)}</dd>
            </div>
          ))}
        </dl>
      );
    case 'each':
      return (
        <>
          {itemsOf(node.of, node.max, scope).flatMap((one, i) =>
            node.children.map((child, j) => (
              <Node
                key={`${i}-${j}`}
                node={child}
                scope={withItem(scope, node.as, one)}
                ctx={ctx}
                depth={depth + 1}
              />
            )),
          )}
        </>
      );
    case 'if':
      return <>{children(holds(node.when, scope, ctx.state) ? node.then : (node.else ?? []))}</>;
    default:
      return null;
  }
};
