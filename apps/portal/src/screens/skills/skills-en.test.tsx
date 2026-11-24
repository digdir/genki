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
    expect(draftChanges({} as never, undefined, [], t)).toEqual(['First edition']);
    expect(scoreText(t, 3, 4)).toBe('3 of 4 (75%)');
  });

  it('explains why a publishing requirement is not met', () => {
    const gate = { kind: 'test_run_on_draft', passed: false, reason: 'stale' } as SkillGate;
    expect(gateLabel(t, gate, 0.8)).toBe('The test set has been run on the draft');
    expect(gateWhy(t, gate)).toBe(
      'The draft or the automatic evaluation has changed since the last run.',
    );
  });

  it('names who published each version, marks the one in use and quotes the reason', () => {
    const versions = [
      {
        version: 1,
        publishedAt: '2026-10-01T08:00:00Z',
        by: 'Kari',
        current: false,
        shared: false,
      },
      {
        version: 2,
        publishedAt: '2026-10-02T08:00:00Z',
        by: 'Per',
        reason: 'Shorter first paragraph',
        current: true,
        shared: false,
      },
    ] as SkillVersion[];
    render(
      inEnglish(
        <VersionsTab versions={versions} services={[{ service: 's', name: 'S', version: 2 }]} />,
      ),
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0]?.textContent).toMatch(
      /^Edition 2 · .* by Per · in use"Shorter first paragraph"$/,
    );
    expect(items[1]?.textContent).toMatch(/^Edition 1 · .* by KariNo reason given\.$/);
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
