import { Alert, Heading, Paragraph } from '@digdir/designsystemet-react';
import { Component, type ReactNode } from 'react';
import { useT } from '../../i18n';

const Fallback = () => {
  const t = useT();
  return (
    <div className="about-prose" role="alert">
      <Heading level={1} data-size="lg">
        {t('about.errorTitle')}
      </Heading>
      <Alert data-color="danger">
        <Paragraph>{t('about.errorBody')}</Paragraph>
      </Alert>
      <a href="#/" onClick={() => window.location.reload()}>
        {t('about.errorReload')}
      </a>
    </div>
  );
};

export class PublicErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <Fallback /> : this.props.children;
  }
}
