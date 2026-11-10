/** The fields of an interface in a block's code that its page does not name as `<code>field</code>`. */
export const propsMissingFromPage = (
  code: string,
  interfaceName: string,
  html: string,
): string[] => {
  const start = code.indexOf(`export interface ${interfaceName} {`);
  if (start < 0) throw new Error(`${interfaceName} is not in the code`);
  const body = code.slice(start, code.indexOf('\n}', start));
  const fields = [...body.matchAll(/^ {2}(?:readonly )?(\w+)\??[:(]/gm)].map(
    ([, name]) => name ?? '',
  );
  if (!fields.length) throw new Error(`${interfaceName} has no fields`);
  return fields.filter((field) => !html.includes(`<code>${field}</code>`));
};
