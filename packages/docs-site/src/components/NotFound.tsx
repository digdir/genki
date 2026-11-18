import { Alert, Heading, Link } from '@digdir/designsystemet-react';

export function NotFound({
  title,
  message,
  back,
}: {
  title: string;
  message: string;
  back: { href: string; label: string };
}) {
  return (
    <div className="stack">
      <Heading level={1} data-size="lg" style={{ margin: 0 }}>
        {title}
      </Heading>
      <Alert data-color="warning">{message}</Alert>
      <Link href={back.href}>{back.label}</Link>
    </div>
  );
}
