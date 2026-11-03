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
import type { ComponentType, ReactNode, SVGProps } from 'react';
import { toneForBlock } from '../components/ArchitectureDiagram';
import { Figure } from '../components/Figure';
import { BlockIcon } from '../components/icons';
import { requireBlock } from '../data/blocks';
import { malbilde, type Point } from '../data/malbilde';
import { href, type Route } from '../router';

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

function PointItem({ p, icons }: { p: Point; icons: Record<string, Icon> }) {
  const I = icons[p.id];
  return (
    <li>
      <Box link={to(p.to)} className="mb-point">
        <IconBadge I={I} />
        <span>
          <strong>{p.title}</strong>
          <span className="mb-point-text">{p.text}</span>
        </span>
      </Box>
    </li>
  );
}

function BlockTile({ id }: { id: string }) {
  const b = requireBlock(id);
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
      <span>{b.name}</span>
    </a>
  );
}

/** Målbildet: hele produktbladet på én side, der hver boks lenker videre. */
export function Malbilde() {
  const infra = requireBlock(malbilde.infraBlock);
  return (
    <div className="stack-lg">
      <Figure className="mb-figure" label="Målbildet" hint="">
        <div className="mb fig">
          <div className="mb-head">
            <Heading level={1} data-size="md">
              {malbilde.title}
            </Heading>
            <Paragraph>{malbilde.subtitle}</Paragraph>
          </div>
          <div className="mb-grid">
            <section className="mb-main" aria-label="Fellesløsningen">
              <div className="mb-users" data-tone="mist">
                <Heading level={2} data-size="2xs" style={{ margin: 0 }}>
                  Offentlige virksomheter
                </Heading>
                <ul className="mb-user-list">
                  {malbilde.users.map((u) => {
                    const I = userIcons[u.name];
                    return (
                      <li key={u.name}>
                        <a className="mb-user" href={u.to} title={u.title}>
                          <IconBadge I={I} />
                          <span>{u.name}</span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>

              <a className="mb-arrow" href={href({ page: 'typer' })}>
                <ArrowDownIcon aria-hidden />
                <span>{malbilde.usersLine}</span>
                <ArrowDownIcon aria-hidden />
              </a>

              <div className="mb-platform">
                <div className="mb-platform-head">
                  <IconBadge I={SparklesIcon} className="big" />
                  <div>
                    <Heading level={2} data-size="sm" style={{ margin: 0 }}>
                      {malbilde.platformTitle}
                    </Heading>
                    <Paragraph data-size="sm" style={{ margin: 0 }}>
                      {malbilde.platformSubtitle}
                    </Paragraph>
                  </div>
                </div>
                <ul className="mb-tiles" aria-label="Nye byggeklosser">
                  {malbilde.newBlocks.map((id) => (
                    <li key={id}>
                      <BlockTile id={id} />
                    </li>
                  ))}
                </ul>
                <div className="mb-sub">
                  <Heading level={3} data-size="2xs" style={{ margin: 0 }}>
                    Gjenbrukes
                  </Heading>
                  <ul className="mb-tiles small" aria-label="Byggeklosser som gjenbrukes">
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
                    <strong>{infra.name}</strong>
                    <span className="mb-point-text">{malbilde.infraText}</span>
                  </span>
                </a>
                <div className="mb-sub" data-tone="lilac">
                  <Heading level={3} data-size="2xs" style={{ margin: 0 }}>
                    Teknologisk grunnlag
                  </Heading>
                  <ul className="mb-principles" aria-label="Prinsipper">
                    {malbilde.principles.map((p) => (
                      <li key={p.id}>
                        <Box link={to(p.to)} className="mb-principle">
                          <IconBadge I={principleIcons[p.id]} />
                          <strong>{p.title}</strong>
                          {p.text && <span className="mb-point-text">{p.text}</span>}
                        </Box>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <a className="mb-arrow" href={href({ page: 'tjenester' })}>
                <ArrowUpIcon aria-hidden />
                <span>{malbilde.resultLine}</span>
                <ArrowUpIcon aria-hidden />
              </a>

              <div className="mb-practice" data-tone="sand">
                <Heading level={2} data-size="2xs" style={{ margin: 0 }}>
                  {malbilde.practiceTitle}
                </Heading>
                <p className="mb-practice-intro">
                  <strong>{malbilde.practiceLead}</strong> {malbilde.practiceIntro}
                </p>
                <ol className="mb-practice-list">
                  {malbilde.practice.map((p, i) => (
                    <li key={p.id}>
                      {i > 0 && <ArrowRightIcon className="mb-practice-arrow" aria-hidden />}
                      <Box link={to(p.to)} className="mb-principle">
                        <IconBadge I={practiceIcons[p.id]} />
                        <strong>{p.title}</strong>
                        <span className="mb-point-text">{p.text}</span>
                      </Box>
                    </li>
                  ))}
                </ol>
              </div>
            </section>

            <section className="mb-side gains" data-tone="sage" aria-labelledby="mb-gains">
              <Heading level={2} data-size="2xs" id="mb-gains" style={{ margin: 0 }}>
                Gevinster for virksomheten
              </Heading>
              <ul className="mb-points">
                {malbilde.gains.map((p) => (
                  <PointItem key={p.id} p={p} icons={pointIcons} />
                ))}
              </ul>
            </section>

            <section className="mb-side effects" data-tone="ocean" aria-labelledby="mb-effects">
              <Heading level={2} data-size="2xs" id="mb-effects" style={{ margin: 0 }}>
                Samlet effekt for sektoren
              </Heading>
              <ul className="mb-points">
                {malbilde.effects.map((p) => (
                  <PointItem key={p.id} p={p} icons={effectIcons} />
                ))}
              </ul>
            </section>
          </div>
          <p className="mb-footer">
            <strong>{malbilde.footer}</strong>
            <span>{malbilde.footerSub}</span>
          </p>
        </div>
      </Figure>
    </div>
  );
}
