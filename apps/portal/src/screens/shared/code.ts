import { publicApiBase } from '../../public-api';
import type { SharedCapability } from '../../data/shared-services';

export type CodeLanguage = 'curl' | 'python' | 'js';

export const API_BASE = publicApiBase;

const json = (value: unknown) => JSON.stringify(value, null, 2);

export const requestBody = (
  capability: SharedCapability,
  publicName: string,
  audioUrl = '<URL til lydfilen>',
) => ({
  model: publicName,
  messages: [
    {
      role: 'user',
      content:
        capability.kind === 'audio' ? audioUrl : `${(capability.sample ?? '').slice(0, 80)}…`,
    },
  ],
  metadata: { tool: `${capability.tool}@${capability.version}`, ...capability.body },
});

export const requestExample = (
  capability: SharedCapability,
  publicName: string,
  language: CodeLanguage,
  audioUrl?: string,
) => {
  const url = `${API_BASE}/v1/chat/completions`;
  const body = json(requestBody(capability, publicName, audioUrl));
  if (language === 'curl')
    return [
      `curl -X POST "${url}" \\`,
      '  -H "Authorization: Bearer $TOKEN" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '${body}'`,
    ].join('\n');
  if (language === 'python')
    return [
      'import os, requests',
      '',
      'svar = requests.post(',
      `    "${url}",`,
      '    headers={"Authorization": f"Bearer {os.environ[\'TOKEN\']}"},',
      `    json=${body.replace(/true/g, 'True').split('\n').join('\n    ')},`,
      '    timeout=120,',
      ')',
      'svar.raise_for_status()',
      'print(svar.json()["choices"][0]["message"]["content"])',
    ].join('\n');
  return [
    `const svar = await fetch("${url}", {`,
    '  method: "POST",',
    '  headers: {',
    '    Authorization: `Bearer ${process.env.TOKEN}`,',
    '    "Content-Type": "application/json",',
    '  },',
    `  body: JSON.stringify(${body.split('\n').join('\n  ')}),`,
    '});',
    'console.log((await svar.json()).choices[0].message.content);',
  ].join('\n');
};

export const responseExample = (capability: SharedCapability, publicName: string) => {
  const content = capability.fields
    ? JSON.stringify(Object.fromEntries(capability.fields))
    : `${(capability.result ?? '').split('\n')[0]} …`;
  const tokens = Number(capability.tokens.replace(/\s/g, ''));
  return json({
    id: 'chatcmpl-example',
    object: 'chat.completion',
    model: publicName,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    ...(Number.isFinite(tokens) && tokens > 0 ? { usage: { total_tokens: tokens } } : {}),
  });
};
