import { sha256Of } from './block-bundles.js';

export const bundleText = "genki.onRender(function (v) { document.body.textContent = 'Figur'; });";

export const codeBlock = (
  tenant: string,
  bundle = bundleText,
  spec: Record<string, unknown> = {},
) => ({
  apiVersion: 'genai/v1',
  kind: 'Block',
  metadata: { tenant, id: 'figur', name: 'Figur' },
  spec: {
    tier: 'code',
    title: { nb: 'Figur', en: 'Figure' },
    zones: ['main'],
    sharing: 'organisation',
    events: ['notify'],
    code: {
      sha256: sha256Of(bundle),
      bytes: Buffer.byteLength(bundle, 'utf8'),
      reads: ['question.text'],
    },
    ...spec,
  },
});
