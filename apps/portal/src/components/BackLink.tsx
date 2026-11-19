export const BackLink = ({ label, href }: { label: string; href: string }) => (
  <a className="back-link" href={href}>
    {label}
  </a>
);
