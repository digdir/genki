import type { DefaultTreeAdapterTypes as T } from 'parse5';

export type Element = T.Element;
export type ChildNode = T.ChildNode;
export type ParentNode = T.ParentNode;

export const isElement = (node: T.Node): node is Element => 'tagName' in node;

export const isText = (node: T.Node): node is T.TextNode => node.nodeName === '#text';

export const childrenOf = (node: ParentNode): ChildNode[] =>
  isElement(node) && node.tagName === 'template'
    ? (node as T.Template).content.childNodes
    : node.childNodes;

export const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value;

export const elementsOf = (node: ParentNode): Element[] => childrenOf(node).filter(isElement);

export const findElement = (root: ParentNode, tag: string): Element | undefined => {
  const stack: ParentNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as ParentNode;
    for (const child of childrenOf(node)) {
      if (!isElement(child)) continue;
      if (child.tagName === tag) return child;
      stack.push(child);
    }
  }
  return undefined;
};

/** Each element under `root`, depth first in document order, with its depth below it. */
export const walk = (root: ParentNode, visit: (el: Element, depth: number) => void) => {
  const stack: { node: Element; depth: number }[] = elementsOf(root)
    .reverse()
    .map((node) => ({ node, depth: 1 }));
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as (typeof stack)[number];
    visit(node, depth);
    const inner = elementsOf(node);
    for (let i = inner.length - 1; i >= 0; i -= 1)
      stack.push({ node: inner[i] as Element, depth: depth + 1 });
  }
};

/** The text of `root` without its scripts and styles, in one pass. */
export const textOf = (root: ParentNode) => {
  const parts: string[] = [];
  const stack: ChildNode[] = [];
  const pushChildren = (node: ParentNode) => {
    const inner = childrenOf(node);
    for (let i = inner.length - 1; i >= 0; i -= 1) stack.push(inner[i] as ChildNode);
  };
  pushChildren(root);
  while (stack.length > 0) {
    const node = stack.pop() as ChildNode;
    if (isText(node)) parts.push(node.value);
    else if (isElement(node) && node.tagName !== 'script' && node.tagName !== 'style')
      pushChildren(node);
  }
  return parts.join('');
};

export const whereOf = (parent: string, tag: string, index: number) =>
  `${parent} > ${tag}${index > 0 ? `[${index + 1}]` : ''}`;
