import { useT } from '../i18n';
import { useInServicePage } from '../screens/service/context';
import { BackLink } from './BackLink';

export const Crumbs = ({ items }: { items: { label: string; href?: string }[] }) => {
  const t = useT();
  const parent = items.findLast((item) => item.href);
  if (useInServicePage() || !parent?.href) return null;
  return (
    <nav aria-label={t('components.breadcrumbs')}>
      <BackLink label={parent.label} href={parent.href} />
    </nav>
  );
};
