/**
 * For tests: the fields of a block's props interface, in its source `code`, that its page in
 * `docs/components/` (`html`) does not name as `<code>field</code>`. Framework-free and without
 * Node, so the package builds it; the tests read the two files.
 */
export const propsMissingFromPage = (
  code: string,
  interfaceName: string,
  html: string,
): string[] => {
  const start = code.indexOf(`export interface ${interfaceName} {`);
  if (start < 0) throw new Error(`${interfaceName} is not in the code`);
  const body = code.slice(start, code.indexOf('\n}', start));
  const fields = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map(([, name]) => name ?? '');
  return fields.filter((field) => !html.includes(`<code>${field}</code>`));
};
