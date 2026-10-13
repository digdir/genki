import {
  Alert,
  Button,
  Checkbox,
  Fieldset,
  Heading,
  Paragraph,
  Radio,
  Spinner,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api';
import { useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import { problemTitle, type ProjectInput, type ProjectSummary } from '../../projects-api';
import { ProjectPage } from './ProjectPage';
import { go, SelectionFields, serviceIdOf, type ProjectsProps } from './shared';

export const Projects = (props: ProjectsProps) => {
  const [, , id, tab, item] = props.path.split('/');
  if (id === 'new') return <NewProject {...props} />;
  if (id)
    return (
      <ProjectPage
        {...props}
        id={decodeURIComponent(id)}
        tab={tab ?? 'data'}
        {...(item ? { item: decodeURIComponent(item) } : {})}
      />
    );
  return <ProjectList {...props} />;
};

const ProjectList = ({ api, tenant }: ProjectsProps) => {
  const t = useT();
  const [projects, retry] = useAsync((signal) => api.list(tenant, signal), [api, tenant]);
  return (
    <div className="projects">
      <div className="page-head-row">
        <div className="page-head">
          <Heading level={1} data-size="lg">
            {t('projects.heading')}
          </Heading>
          <Paragraph className="subtle">{t('projects.intro')}</Paragraph>
        </div>
        <Button onClick={() => go('/projects/new')}>{t('projects.newProject')}</Button>
      </div>
      {projects.status === 'loading' ? (
        <Spinner aria-label={t('projects.loading')} data-size="md" />
      ) : projects.status === 'error' &&
        projects.error instanceof ApiError &&
        projects.error.status === 403 ? (
        <Alert data-color="info" data-size="sm">
          <Paragraph data-size="sm">{t('projects.noAccess')}</Paragraph>
        </Alert>
      ) : projects.status === 'error' ? (
        <Alert data-color="danger" data-size="sm">
          <Paragraph data-size="sm">{t('projects.loadFailed')}</Paragraph>
          <Button variant="secondary" data-size="sm" onClick={retry}>
            {t('projects.tryAgain')}
          </Button>
        </Alert>
      ) : projects.data.length === 0 ? (
        <div className="panel empty-project">
          <Heading level={2} data-size="xs">
            {t('projects.emptyHeading')}
          </Heading>
          <Paragraph>{t('projects.emptyText')}</Paragraph>
          <Button data-size="sm" onClick={() => go('/projects/new')}>
            {t('projects.newProject')}
          </Button>
        </div>
      ) : (
        <ul className="project-cards" aria-label={t('projects.heading')}>
          {projects.data.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </ul>
      )}
    </div>
  );
};

const ProjectCard = ({ project }: { project: ProjectSummary }) => {
  const t = useT();
  const f = useFormat();
  return (
    <li className="panel project-card">
      <Heading level={2} data-size="xs">
        <a href={`#/projects/${encodeURIComponent(project.id)}`}>{project.name}</a>
      </Heading>
      {project.purpose ? <Paragraph data-size="sm">{project.purpose}</Paragraph> : null}
      <div className="tags">
        <Tag data-size="sm" data-color="neutral">
          {t('projects.selections', { count: project.selections.length })}
        </Tag>
        {project.fresh > 0 ? (
          <Tag data-size="sm" data-color="info">
            {t('projects.freshDocuments', { count: project.fresh })}
          </Tag>
        ) : null}
        {project.paused > 0 ? (
          <Tag data-size="sm" data-color="warning">
            {t('projects.subscriptionPaused')}
          </Tag>
        ) : null}
      </div>
      <span className="subtle-sm">
        {t('projects.lastActivity', { date: f.date(project.at) })}
        {project.changedBy ? ` · ${project.changedBy}` : ''}
      </span>
    </li>
  );
};

const firstData = [
  ['selection', 'projects.firstSelection'],
  ['documents', 'projects.firstDocuments'],
  ['files', 'projects.firstFiles'],
] as const satisfies readonly (readonly [string, PlainKey])[];

const NewProject = ({ api, tenant, services, onFlash }: ProjectsProps) => {
  const t = useT();
  const [sources] = useAsync((signal) => api.sources(tenant, signal), [api, tenant]);
  const [existing] = useAsync((signal) => api.list(tenant, signal), [api, tenant]);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [first, setFirst] = useState<(typeof firstData)[number][0]>('selection');
  const [dataset, setDataset] = useState('');
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [chosen, setChosen] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const list = sources.status === 'ready' ? sources.data : [];
  const datasetId = dataset || list[0]?.id || '';
  const nameTaken =
    existing.status === 'ready' &&
    existing.data.some((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (busy || !name.trim() || nameTaken) return;
    setBusy(true);
    setError('');
    const body: ProjectInput = {
      name: name.trim(),
      purpose: purpose.trim(),
      selections:
        first === 'selection' && datasetId
          ? [{ id: '', name: t('projects.defaultSelection'), dataset: datasetId, filters }]
          : [],
      services: chosen.map(serviceIdOf),
    };
    try {
      const created = await api.create(tenant, body, t('projects.createdReason'));
      onFlash(t('projects.created'));
      go(`/projects/${encodeURIComponent(created.id)}`);
    } catch (e) {
      setError(problemTitle(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel project-form" onSubmit={create} noValidate>
      <Heading level={1} data-size="md">
        {t('projects.newProject')}
      </Heading>
      <Textfield
        id="prosjekt-navn"
        label={t('projects.name')}
        value={name}
        {...(tried && !name.trim()
          ? { error: t('projects.nameMissing') }
          : nameTaken
            ? { error: t('projects.nameTaken') }
            : {})}
        onChange={(e) => setName(e.target.value)}
      />
      <Textfield
        id="prosjekt-formal"
        multiline
        rows={4}
        label={t('projects.purpose')}
        description={t('projects.purposeHelp')}
        value={purpose}
        onChange={(e) => setPurpose(e.target.value)}
      />
      <Fieldset data-size="sm">
        <Fieldset.Legend>{t('projects.firstData')}</Fieldset.Legend>
        {firstData.map(([key, label]) => (
          <Radio
            key={key}
            name="forste-datagrunnlag"
            label={t(label)}
            checked={first === key}
            disabled={key !== 'selection'}
            onChange={() => setFirst(key)}
          />
        ))}
      </Fieldset>
      {first === 'selection' ? (
        sources.status === 'loading' ? (
          <Spinner aria-label={t('projects.loadingDatasets')} data-size="sm" />
        ) : list.length ? (
          <SelectionFields
            sources={list}
            dataset={datasetId}
            filters={filters}
            onChange={(d, f) => {
              setDataset(d);
              setFilters(f);
            }}
          />
        ) : (
          <Paragraph data-size="sm">{t('projects.noDatasets')}</Paragraph>
        )
      ) : (
        <Paragraph data-size="sm">{t('projects.notYet')}</Paragraph>
      )}
      {services.length ? (
        <Fieldset data-size="sm">
          <Fieldset.Legend>{t('projects.services')}</Fieldset.Legend>
          <Fieldset.Description>{t('projects.servicesHelp')}</Fieldset.Description>
          {services.map((s) => (
            <Checkbox
              key={s.id}
              label={s.name}
              checked={chosen.includes(s.id)}
              onChange={(e) =>
                setChosen((c) => (e.target.checked ? [...c, s.id] : c.filter((x) => x !== s.id)))
              }
            />
          ))}
        </Fieldset>
      ) : null}
      {error ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          {error}
        </Alert>
      ) : null}
      <div className="actions">
        <Button type="submit" aria-disabled={busy || undefined}>
          {t('projects.create')}
        </Button>
        <Button variant="secondary" type="button" onClick={() => go('/projects')}>
          {t('projects.cancel')}
        </Button>
      </div>
    </form>
  );
};
