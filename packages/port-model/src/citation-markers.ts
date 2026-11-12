export const normaliseCitationMarkers = (text: string): string =>
  text.replace(/【 ?(\d+)(?::\d+)?(?:†[^】\n]{0,200})? ?】/g, '[$1]');
