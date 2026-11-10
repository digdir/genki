/** For tests: the fields of an interface in a block's code that its page does not name. */
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
