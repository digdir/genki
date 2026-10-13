// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillGate, SkillVersion } from '../../api/skills';
import { draftChanges, gateLabel, gateWhy, scoreText } from '../../data/skills';
import { translator } from '../../i18n';
import { FixCard } from './FixCard';
import { RejectedCard } from './RejectedCard';
import { VersionsTab } from './VersionsTab';

afterEach(cleanup);

const t = translator('en');

describe('skills in English', () => {
  it('describes draft changes and scores', () => {
    expect(draftChanges({} as never, undefined, [], t)).toEqual(['First version']);
    expect(scoreText(t, 3, 4)).toBe('3 of 4 (75%)');
  });

  it('explains why a publishing requirement is not met', () => {
    const gate = { kind: 'test_run_on_draft', passed: false, reason: 'stale' } as SkillGate;
    expect(gateLabel(t, gate, 0.8)).toBe('The test set has been run on the draft');
    expect(gateWhy(t, gate)).toBe('The draft has changed since the last run.');
  });

  it('renders the version list', () => {
    const version = {
      version: 2,
      publishedAt: '2026-10-01T08:00:00Z',
      by: 'Kari',
      current: true,
      score: null,
    } as unknown as SkillVersion;
    render(
      inEnglish(
        <VersionsTab draft={{ version: 3, changes: [], score: 'x' }} versions={[version]} inUse />,
      ),
    );
    expect(screen.getByText('Draft of version 3')).toBeTruthy();
    expect(screen.getByText('Version 2')).toBeTruthy();
    expect(screen.getByText('In use')).toBeTruthy();
    expect(screen.getByText('No test set')).toBeTruthy();
  });

  it('renders the rejected and fix cards', () => {
    render(
      inEnglish(
        <>
          <RejectedCard
            card={{ id: '1', section: 'description', attempted: 'a', reason: 'b', code: 'X' }}
          />
          <FixCard
            fix={{ fixId: 'f', before: 'x', after: 'y' } as never}
            busy={false}
            onApply={() => {}}
            onDiscard={() => {}}
          />
        </>,
      ),
    );
    expect(screen.getByText('Rejected by the platform, not used')).toBeTruthy();
    expect(screen.getByText("The assistant's suggestion for the instructions")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use the change' })).toBeTruthy();
  });
});
