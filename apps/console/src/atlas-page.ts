export const atlasScriptFile = 'system-atlas.js';

export const separateAtlasScript = (html: string) => {
  const open = html.indexOf('<script>');
  const close = html.lastIndexOf('</script>');
  if (open < 0 || close < open || html.indexOf('<script', open + 1) !== -1)
    throw new Error('the System Atlas must have exactly one inline script');
  return {
    html: `${html.slice(0, open)}<script src="/${atlasScriptFile}"></script>${html.slice(close + '</script>'.length)}`,
    script: html.slice(open + '<script>'.length, close),
  };
};
