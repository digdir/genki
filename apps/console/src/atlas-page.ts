export const atlasScriptFile = 'system-atlas.js';

export const separateAtlasScript = (html: string) => {
  const lower = html.toLowerCase();
  const open = lower.indexOf('<script>');
  const close = lower.lastIndexOf('</script>');
  if (open < 0 || close < open || lower.indexOf('<script', open + 1) !== -1)
    throw new Error('the System Atlas must have exactly one inline script');
  return {
    html: `${html.slice(0, open)}<script src="/${atlasScriptFile}"></script>${html.slice(close + '</script>'.length)}`,
    script: html.slice(open + '<script>'.length, close),
  };
};
