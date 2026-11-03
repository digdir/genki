import { Heading, Paragraph } from '@digdir/designsystemet-react';
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ArrowRightLeftIcon,
  ArrowsCirclepathIcon,
  BooksIcon,
  BranchingIcon,
  BriefcaseIcon,
  Buildings2Icon,
  CloudIcon,
  CodeIcon,
  CompassIcon,
  HandHeartIcon,
  HandshakeIcon,
  HospitalIcon,
  HouseHeartIcon,
  LightBulbIcon,
  LightningIcon,
  PersonGroupIcon,
  PiggybankIcon,
  PuzzlePieceIcon,
  RocketIcon,
  ShieldCheckmarkIcon,
  SparklesIcon,
  TerminalIcon,
  WrenchIcon,
} from '@navikt/aksel-icons';
import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type SVGProps,
} from 'react';
import { useLocale } from '@genai/i18n/react';
import { toneForBlock } from '../components/ArchitectureDiagram';
import { Figure } from '../components/Figure';
import { BlockIcon } from '../components/icons';
import { localName, requireBlock, malbilde, type Point } from '@genai/docs-content';
import { href, type Route } from '../router';
import { useContentLang, useDocumentTitle } from '../document';
import { useT } from '../i18n';

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const pointIcons: Record<string, Icon> = {
  kostnad: PiggybankIcon,
  fart: LightningIcon,
  sikkerhet: ShieldCheckmarkIcon,
  innovasjon: LightBulbIcon,
  valgfrihet: ArrowRightLeftIcon,
  handlingsrom: CompassIcon,
  innbyggere: PersonGroupIcon,
  trygg: ShieldCheckmarkIcon,
  gjenbruk: ArrowsCirclepathIcon,
  samarbeid: HandshakeIcon,
  utvikling: RocketIcon,
  kompetanse: BooksIcon,
  verdi: HandHeartIcon,
};
/** Samlet effekt bruker Branching for valgfrihet, så de to spaltene ikke får like ikoner. */
const effectIcons: Record<string, Icon> = { ...pointIcons, valgfrihet: BranchingIcon };

const principleIcons: Record<string, Icon> = {
  kode: CodeIcon,
  api: TerminalIcon,
  standarder: BooksIcon,
  modular: PuzzlePieceIcon,
  drift: CloudIcon,
};
const practiceIcons: Record<string, Icon> = {
  ide: LightBulbIcon,
  bygge: WrenchIcon,
  tjeneste: RocketIcon,
};

const userIcons: Record<string, Icon> = {
  Kommuner: HouseHeartIcon,
  Direktorater: BriefcaseIcon,
  Etater: PersonGroupIcon,
  Sykehus: HospitalIcon,
  Utdanning: BooksIcon,
  Fylker: Buildings2Icon,
};

const to = (t: Point['to']) => (typeof t === 'string' ? t : t ? href(t as Route) : undefined);

/** Lenke når punktet har et mål, ellers en vanlig boks med samme utseende. */
function Box({
  link,
  className,
  children,
}: {
  link?: string;
  className: string;
  children: ReactNode;
}) {
  return link ? (
    <a className={className} href={link}>
      {children}
    </a>
  ) : (
    <div className={className}>{children}</div>
  );
}

/** Rund, fylt ikonplate i områdets farge. */
function IconBadge({ I, className }: { I?: Icon; className?: string }) {
  return (
    <span className={`mb-badge${className ? ` ${className}` : ''}`}>{I && <I aria-hidden />}</span>
  );
}

const useEnglish = () => useLocale().locale === 'en';

const pointTitle = (p: Point, en: boolean) => (en ? p.titleEn : p.title);

function PointItem({ p, icons }: { p: Point; icons: Record<string, Icon> }) {
  const I = icons[p.id];
  const en = useEnglish();
  const lang = useContentLang();
  return (
    <li>
      <Box link={to(p.to)} className="mb-point">
        <IconBadge I={I} />
        <span>
          <strong>{pointTitle(p, en)}</strong>
          <span className="mb-point-text" lang={lang}>
            {p.text}
          </span>
        </span>
      </Box>
    </li>
  );
}

function FitToScreen({ active, children }: { active: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) {
      setZoom(1);
      return;
    }
    const fit = () => {
      const height = el.scrollHeight / zoomOf(el);
      setZoom(Math.min(1, (window.innerHeight - 124) / height));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [active]);
  return (
    <div ref={ref} className="mb-fit" style={zoom < 1 ? { zoom } : undefined}>
      {children}
    </div>
  );
}

const zoomOf = (el: HTMLElement) => Number(el.style.zoom) || 1;

function BlockTile({ id }: { id: string }) {
  const b = requireBlock(id);
  const { locale } = useLocale();
  return (
    <a
      className="mb-tile"
      href={href({ page: 'byggeklosser', id })}
      data-tone={toneForBlock[id]}
      title={b.tagline}
    >
      <span className="mb-tile-icon">
        <BlockIcon id={id} />
      </span>
      <span>{localName(b, locale)}</span>
    </a>
  );
}

/** Målbildet: hele produktbladet på én side, der hver boks lenker videre. */
export function Malbilde() {
  const t = useT();
  const lang = useContentLang();
  const en = useEnglish();
  const { locale } = useLocale();
  const head = en ? malbilde.en : malbilde;
  useDocumentTitle(head.title);
  const infra = requireBlock(malbilde.infraBlock);
  return (
    <div className="stack-lg">
      <Figure className="mb-figure" label={t('docsFigure.target')} hint="">
        {(isFull) => (
          <FitToScreen active={isFull}>
            <div className="mb fig">
              <div className="mb-head">
                <Heading level={1} data-size="md">
                  {head.title}
                </Heading>
                <Paragraph>{head.subtitle}</Paragraph>
              </div>
              <div className="mb-grid">
                <section className="mb-main" aria-label={t('docsTarget.platform')}>
                  <div className="mb-users" data-tone="mist">
                    <Heading level={2} data-size="2xs" style={{ margin: 0 }}>
                      {t('docsTarget.users')}
                    </Heading>
                    <ul className="mb-user-list">
                      {malbilde.users.map((u) => {
                        const I = userIcons[u.name];
                        return (
                          <li key={u.name}>
                            <a className="mb-user" href={u.to} title={u.title}>
                              <IconBadge I={I} />
                              <span>{en ? u.nameEn : u.name}</span>
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  </div>

                  <a className="mb-arrow" href={href({ page: 'typer' })}>
                    <ArrowDownIcon aria-hidden />
                    <span>{head.usersLine}</span>
                    <ArrowDownIcon aria-hidden />
                  </a>

                  <div className="mb-platform">
                    <div className="mb-platform-head">
                      <IconBadge I={SparklesIcon} className="big" />
                      <div>
                        <Heading level={2} data-size="sm" style={{ margin: 0 }}>
                          {head.platformTitle}
                        </Heading>
                        <Paragraph data-size="sm" style={{ margin: 0 }}>
                          {head.platformSubtitle}
                        </Paragraph>
                      </div>
                    </div>
                    <ul className="mb-tiles" aria-label={t('docsTarget.newBlocks')}>
                      {malbilde.newBlocks.map((id) => (
                        <li key={id}>
                          <BlockTile id={id} />
                        </li>
                      ))}
                    </ul>
                    <div className="mb-sub">
                      <Heading level={3} data-size="2xs" style={{ margin: 0 }}>
                        {t('docsTarget.reused')}
                      </Heading>
                      <ul className="mb-tiles small" aria-label={t('docsTarget.reusedLabel')}>
                        {malbilde.reusedBlocks.map((id) => (
                          <li key={id}>
                            <BlockTile id={id} />
                          </li>
                        ))}
                      </ul>
                    </div>
                    <a
                      className="mb-band"
                      href={href({ page: 'byggeklosser', id: infra.id })}
                      data-tone={toneForBlock[infra.id]}
                    >
                      <span className="mb-tile-icon">
                        <BlockIcon id={infra.id} />
                      </span>
                      <span>
                        <strong>{localName(infra, locale)}</strong>
                        <span className="mb-point-text" lang={lang}>
                          {malbilde.infraText}
                        </span>
                      </span>
                    </a>
                    <div className="mb-sub" data-tone="lilac">
                      <Heading level={3} data-size="2xs" style={{ margin: 0 }}>
                        {t('docsTarget.foundation')}
                      </Heading>
                      <ul className="mb-principles" aria-label={t('docsTarget.principles')}>
                        {malbilde.principles.map((p) => (
                          <li key={p.id}>
                            <Box link={to(p.to)} className="mb-principle">
                              <IconBadge I={principleIcons[p.id]} />
                              <strong>{pointTitle(p, en)}</strong>
                              {p.text && (
                                <span className="mb-point-text" lang={lang}>
                                  {p.text}
                                </span>
                              )}
                            </Box>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <a className="mb-arrow" href={href({ page: 'tjenester' })}>
                    <ArrowUpIcon aria-hidden />
                    <span>{head.resultLine}</span>
                    <ArrowUpIcon aria-hidden />
                  </a>

                  <div className="mb-practice" data-tone="sand">
                    <Heading level={2} data-size="2xs" style={{ margin: 0 }}>
                      {head.practiceTitle}
                    </Heading>
                    <p className="mb-practice-intro">
                      <strong>{head.practiceLead}</strong>{' '}
                      <span lang={lang}>{malbilde.practiceIntro}</span>
                    </p>
                    <ol className="mb-practice-list">
                      {malbilde.practice.map((p, i) => (
                        <li key={p.id}>
                          {i > 0 && <ArrowRightIcon className="mb-practice-arrow" aria-hidden />}
                          <Box link={to(p.to)} className="mb-principle">
                            <IconBadge I={practiceIcons[p.id]} />
                            <strong>{pointTitle(p, en)}</strong>
                            <span className="mb-point-text" lang={lang}>
                              {p.text}
                            </span>
                          </Box>
                        </li>
                      ))}
                    </ol>
                  </div>
                </section>

                <section className="mb-side gains" data-tone="sage" aria-labelledby="mb-gains">
                  <Heading level={2} data-size="2xs" id="mb-gains" style={{ margin: 0 }}>
                    {t('docsTarget.gains')}
                  </Heading>
                  <ul className="mb-points">
                    {malbilde.gains.map((p) => (
                      <PointItem key={p.id} p={p} icons={pointIcons} />
                    ))}
                  </ul>
                </section>

                <section className="mb-side effects" data-tone="ocean" aria-labelledby="mb-effects">
                  <Heading level={2} data-size="2xs" id="mb-effects" style={{ margin: 0 }}>
                    {t('docsTarget.effects')}
                  </Heading>
                  <ul className="mb-points">
                    {malbilde.effects.map((p) => (
                      <PointItem key={p.id} p={p} icons={effectIcons} />
                    ))}
                  </ul>
                </section>
              </div>
              <p className="mb-footer">
                <strong>{head.footer}</strong>
                <span>{head.footerSub}</span>
              </p>
            </div>
          </FitToScreen>
        )}
      </Figure>
    </div>
  );
}
