import { Link, Paragraph, Tag } from '@digdir/designsystemet-react';
import type { AssistantTurn, AssistantTurnRequest } from '../../../api/assistant';
import { CopyButton } from '../../../components/CopyButton';
import { SidePanel } from '../../../components/SidePanel';
import { useT, type T } from '../../../i18n';
import { publicApiBase } from '../../../public-api';

export interface MessageCall {
  path: string;
  request: Omit<AssistantTurnRequest, 'draft'>;
  response: AssistantTurn;
}

const curl = (path: string, request: MessageCall['request'], t: T) =>
  [
    `curl -X POST "${publicApiBase}${path}" \\`,
    '  -H "Authorization: Bearer $TOKEN" \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Accept: text/event-stream" \\',
    `  -d '${JSON.stringify(
      { ...request, draft: { definition: t('assistant.apiDraftPlaceholder') }, stream: true },
      null,
      2,
    )}'`,
  ].join('\n');

const Block = ({ label, code }: { label: string; code: string }) => {
  const t = useT();
  return (
    <div className="ax-code">
      <div className="ax-code-head">
        <span>{label}</span>
        <CopyButton
          text={code}
          ariaLabel={t('assistant.apiCopy', { label: label.toLowerCase() })}
        />
      </div>
      <pre tabIndex={0} aria-label={label}>
        <code>{code}</code>
      </pre>
    </div>
  );
};

export const MessageApiCall = ({ call, onClose }: { call: MessageCall; onClose: () => void }) => {
  const t = useT();
  return (
    <SidePanel title={call.path} eyebrow={t('assistant.apiEyebrow')} onClose={onClose} width={520}>
      <Paragraph data-size="sm">{t('assistant.apiIntro')}</Paragraph>
      <p className="api-line">
        <Tag data-color="success" data-size="sm">
          POST
        </Tag>
        <code>{call.path}</code>
      </p>
      <Block label={t('assistant.apiRequest')} code={curl(call.path, call.request, t)} />
      <Block label={t('assistant.apiResponse')} code={JSON.stringify(call.response, null, 2)} />
      <Link href="#/api-reference">{t('assistant.apiReference')}</Link>
    </SidePanel>
  );
};
