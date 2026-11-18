import { Button, Card, Heading, Link, Paragraph, ToggleGroup } from '@digdir/designsystemet-react';
import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon } from '@navikt/aksel-icons';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useContentLang, useDocumentTitle } from '../document';
import { ArchitectureDiagram, toneForBlock, type NodeId } from '../components/ArchitectureDiagram';
import { BackLink } from '../components/BackLink';
import { Figure } from '../components/Figure';
import { BlockIcon } from '../components/icons';
import { blockById, caseById } from '@genai/docs-content';
import { href } from '../router';
import { useT } from '../i18n';

const STEP_MS = 4500;

export function CaseFlow({
  id,
  del,
  steg,
}: {
  id: string;
  del?: 'bruk' | 'oppsett';
  steg?: number;
}) {
  const t = useT();
  const lang = useContentLang();
  const c = caseById(id);
  useDocumentTitle(c?.name ?? t('docsFlow.notFound'));
  const region = useRef<HTMLDivElement>(null);
  // To deler av samme flyt: bruk av tjenesten, og oppsett i Genki.
  const [part, setPart] = useState<'bruk' | 'oppsett'>('bruk');
  const flowSteps = (part === 'oppsett' ? c?.setup : c?.steps) ?? [];
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [full, setFull] = useState(false);
  // Siden beholdes når man bytter flyt, så tilstanden nullstilles når id endres.
  useEffect(() => {
    const part = del ?? 'bruk';
    const total = (part === 'oppsett' ? c?.setup : c?.steps)?.length ?? 1;
    setPart(part);
    setI(steg ? Math.min(steg, total) - 1 : 0);
    setPlaying(false);
  }, [id, del, steg]);
  const choosePart = (p: 'bruk' | 'oppsett') => {
    setPart(p);
    setI(0);
    setPlaying(false);
  };
  const step = flowSteps[i];
  const block = step ? blockById(step.block) : undefined;

  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setI((x) => (x + 1) % flowSteps.length), STEP_MS);
    return () => clearTimeout(t);
  }, [i, playing]);

  const go = (n: number) => {
    setI((n + flowSteps.length) % flowSteps.length);
  };

  // Piltaster bytter steg uansett hvor fokus er, også i fullskjerm. Ikke når man skriver i et felt.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inFlow =
        !!t &&
        (!!region.current?.contains(t) ||
          !!document.fullscreenElement?.contains(t) ||
          !!t.closest('.figure.is-full'));
      if (!inFlow) return;
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      )
        return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        setPlaying(false);
        if (e.key === 'ArrowRight') setI((x) => (x + 1) % flowSteps.length);
        else if (e.key === 'ArrowLeft') setI((x) => (x - 1 + flowSteps.length) % flowSteps.length);
        else if (e.key === 'Home') setI(0);
        else setI(flowSteps.length - 1);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [flowSteps.length]);

  if (!c || !step || !block) {
    return (
      <div className="stack">
        <Heading level={1} data-size="lg" style={{ margin: 0 }}>
          {t('docsFlow.notFound')}
        </Heading>
        <Link href={href({ page: 'tjenester' })}>{t('docsFlow.toFlows')}</Link>
      </div>
    );
  }

  // Delene av flytsiden, så de kan vises enten på siden eller inne i fullskjermvisningen.
  const diagram = (
    <ArchitectureDiagram highlight={step.node as NodeId | 'data'} interactive={false} />
  );
  const controls = (
    <>
      <div className="flow-controls">
        <Button
          variant="secondary"
          icon
          aria-label={t('docsFlow.previous')}
          onClick={() => {
            setPlaying(false);
            go(i - 1);
          }}
        >
          <ChevronLeftIcon aria-hidden />
        </Button>
        <Button variant="primary" onClick={() => setPlaying((p) => !p)}>
          {playing ? <PauseIcon aria-hidden /> : <PlayIcon aria-hidden />}
          {playing ? t('docsFlow.pause') : t('docsFlow.play')}
        </Button>
        <Button
          variant="secondary"
          icon
          aria-label={t('docsFlow.next')}
          onClick={() => {
            setPlaying(false);
            go(i + 1);
          }}
        >
          <ChevronRightIcon aria-hidden />
        </Button>
        <Paragraph
          data-size="sm"
          aria-live={playing ? 'off' : 'polite'}
          style={{ margin: 0, color: 'var(--ds-color-neutral-text-subtle)' }}
        >
          {t('docsFlow.stepOf', { step: i + 1, total: flowSteps.length })}
        </Paragraph>
      </div>
      <div className="progress" aria-hidden>
        <motion.div
          key={`${i}-${playing}`}
          initial={{ width: '0%' }}
          animate={{ width: playing ? '100%' : '0%' }}
          transition={{
            duration: playing ? STEP_MS / 1000 : 0,
            ease: 'linear',
          }}
        />
      </div>
    </>
  );
  const stepCard = (
    <AnimatePresence mode="wait">
      <motion.div
        key={`${part}-${step.id}`}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={{ duration: 0.25 }}
      >
        <Card className="fig flow-card" data-tone={toneForBlock[block.id]}>
          <Card.Block>
            <div className="block-card-head">
              <span className="block-icon toned">
                <BlockIcon id={block.id} />
              </span>
              <div>
                <Paragraph
                  data-size="xs"
                  style={{ margin: 0, color: 'var(--ds-color-text-subtle)' }}
                >
                  {t('docsFlow.stepIn', { step: i + 1, block: block.name })}
                </Paragraph>
                <Heading level={2} data-size="sm" style={{ margin: 0 }} lang={lang}>
                  {step.title}
                </Heading>
              </div>
            </div>
          </Card.Block>
          <Card.Block>
            <Paragraph style={{ margin: 0 }} lang={lang}>
              {step.text}
            </Paragraph>
          </Card.Block>
          <Card.Block>
            <Link href={href({ page: 'byggeklosser', id: block.id })}>
              {t('docsFlow.moreAbout', { name: block.name })}
            </Link>
          </Card.Block>
        </Card>
      </motion.div>
    </AnimatePresence>
  );
  const stepList = (
    <ol className="flow-steps" aria-label={t('docsFlow.steps')}>
      {flowSteps.map((s, n) => (
        <li key={s.id}>
          <button
            type="button"
            className="flow-step"
            aria-current={n === i ? 'step' : undefined}
            onClick={() => {
              setPlaying(false);
              setI(n);
            }}
          >
            <span className="num" aria-hidden>
              {n + 1}
            </span>
            <strong lang={lang}>{s.title}</strong>
          </button>
        </li>
      ))}
    </ol>
  );

  return (
    <div className="stack-lg">
      <div className="stack">
        <BackLink href={href({ page: 'tjenester' })}>{t('docsFlow.all')}</BackLink>
        <div className="cluster" style={{ alignItems: 'center' }}>
          <Heading level={1} data-size="lg" style={{ margin: 0 }} lang={lang}>
            {c.name}
          </Heading>
        </div>
        <Paragraph className="lede" style={{ margin: 0 }} lang={lang}>
          {c.intro}
        </Paragraph>
      </div>

      <ToggleGroup
        value={part}
        onChange={(v) => choosePart(v as 'bruk' | 'oppsett')}
        data-size="sm"
        aria-label={t('docsFlow.choosePart')}
      >
        <ToggleGroup.Item value="bruk">
          {t('docsFlow.partUse', { count: c.steps.length })}
        </ToggleGroup.Item>
        <ToggleGroup.Item value="oppsett">
          {t('docsFlow.partSetup', { count: c.setup.length })}
        </ToggleGroup.Item>
      </ToggleGroup>

      <div className="flow-layout" ref={region}>
        <div className="stack">
          <Figure
            className="diagram-wrap"
            label={t('docsFigure.flow')}
            hint={t('docsFigure.hintSteps')}
            onFullChange={setFull}
          >
            {(isFull) =>
              isFull ? (
                <div className="flow-full">
                  <div className="stack">
                    {diagram}
                    {controls}
                    {stepCard}
                  </div>
                  {stepList}
                </div>
              ) : (
                diagram
              )
            }
          </Figure>
          {!full && controls}
          {!full && stepCard}
        </div>
        {!full && stepList}
      </div>
    </div>
  );
}
