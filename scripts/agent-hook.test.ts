import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentHooksOff,
  bashDecision,
  isPushCommand,
  parsePushedRefs,
  prePushDecision,
  stopDecision,
} from './agent-hook.ts';
import { hooksPathArgs, hooksPathWanted, repoRoot } from './setup.ts';

const stale = { ownChanges: true, fresh: false };
const fresh = { ownChanges: true, fresh: true };
const noDiff = { ownChanges: false, fresh: false };

describe('the Stop hook', () => {
  it('blocks with "run npm run verify" while the stamp is stale', () => {
    const decision = stopDecision(stale, false);
    expect(decision.code).toBe(2);
    expect(decision.stderr).toMatch(/run npm run verify/);
  });

  it('allows stopping when the stamp matches the working tree', () => {
    expect(stopDecision(fresh, false).code).toBe(0);
  });

  it('allows stopping when there is no diff against origin/main', () => {
    expect(stopDecision(noDiff, false)).toEqual({ code: 0 });
  });

  it('allows with a warning to the user when it already blocked once', () => {
    const decision = stopDecision(stale, true);
    expect(decision.code).toBe(0);
    expect(JSON.parse(decision.stdout ?? '{}').systemMessage).toMatch(/stale verify stamp/);
  });
});

describe('the Bash hook', () => {
  it('recognises a push or a new pull request, however git is called', () => {
    for (const command of [
      'git push',
      'git push -u origin verify-gate',
      'git -C ../genki-x push',
      'npm run verify && git push --force-with-lease',
      'gh pr create --fill',
      'cd ../genki-x && git push',
      'GIT_SSH_COMMAND=ssh git push',
    ])
      expect(isPushCommand(command), command).toBe(true);
    for (const command of [
      'git status',
      'gh pr view 12',
      'git log --grep push',
      'npm run verify',
      'git commit -m "block git push when stale"',
      'grep -n "gh pr create" AGENTS.md',
    ])
      expect(isPushCommand(command), command).toBe(false);
  });

  it('matches commands in linear time', () => {
    const started = performance.now();
    isPushCommand(`${'a=b '.repeat(20_000)}git ${'-x '.repeat(20_000)}`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('blocks a push while the stamp is stale', () => {
    expect(bashDecision('git push', stale).code).toBe(2);
    expect(bashDecision('gh pr create', stale).stderr).toMatch(/run npm run verify/);
  });

  it('allows a push when the stamp is fresh or there is nothing to push', () => {
    expect(bashDecision('git push', fresh).code).toBe(0);
    expect(bashDecision('git push', noDiff).code).toBe(0);
  });

  it('allows every other command, even with a stale stamp', () => {
    expect(bashDecision('npx vitest run --changed origin/main', stale).code).toBe(0);
  });

  it('stays out of the way in GitHub Actions, where the review runs Claude Code', () => {
    expect(agentHooksOff({ GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(agentHooksOff({})).toBe(false);
  });
});

describe('the pre-push hook', () => {
  it('reads the pushed refs and skips deletions and tags', () => {
    const zero = '0'.repeat(40);
    expect(
      parsePushedRefs(
        [
          `refs/heads/a 1111 refs/heads/a ${zero}`,
          `(delete) ${zero} refs/heads/old 2222`,
          `refs/tags/v1 3333 refs/tags/v1 ${zero}`,
        ].join('\n'),
      ),
    ).toEqual([{ localRef: 'refs/heads/a', localSha: '1111' }]);
  });

  it('pushes without verifying again when the pushed tree is the one verify passed', () => {
    expect(prePushDecision(['tree1'], 'tree1', 'tree2')).toBe('allow');
    expect(prePushDecision([], undefined, 'tree1')).toBe('allow');
  });

  it('runs verify when the stamp is stale and the working tree is what is pushed', () => {
    expect(prePushDecision(['tree1'], 'tree0', 'tree1')).toBe('verify');
    expect(prePushDecision(['tree1'], undefined, 'tree1')).toBe('verify');
  });

  it('refuses when the working tree differs from what is pushed, since verify cannot check that', () => {
    expect(prePushDecision(['tree1'], 'tree0', 'tree2')).toBe('dirty');
    expect(prePushDecision(['tree1', 'tree2'], 'tree0', 'tree1')).toBe('dirty');
  });

  it('is installed by setup unless the contributor points git at other hooks', () => {
    expect(hooksPathWanted(undefined)).toBe(true);
    expect(hooksPathWanted('.githooks')).toBe(true);
    expect(hooksPathWanted('.husky')).toBe(false);
  });

  it('runs the hook script', () => {
    const hook = join(repoRoot, hooksPathArgs[2] ?? '', 'pre-push');
    expect(statSync(hook).mode & 0o111).not.toBe(0);
    expect(readFileSync(hook, 'utf8')).toContain('scripts/agent-hook.ts pre-push');
  });
});

describe('the Claude Code settings', () => {
  const settings = JSON.parse(readFileSync(join(repoRoot, '.claude/settings.json'), 'utf8')) as {
    hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  };
  const commandFor = (event: string) => settings.hooks[event]?.[0];

  it('formats edited files, guards pushes and checks the stamp before stopping', () => {
    expect(commandFor('PostToolUse')?.matcher).toBe('Edit|MultiEdit|Write');
    expect(commandFor('PostToolUse')?.hooks[0]?.command).toMatch(/agent-hook\.ts" post-edit$/);
    expect(commandFor('PreToolUse')?.matcher).toBe('Bash');
    expect(commandFor('PreToolUse')?.hooks[0]?.command).toMatch(/agent-hook\.ts" bash$/);
    expect(commandFor('Stop')?.hooks[0]?.command).toMatch(/agent-hook\.ts" stop$/);
  });
});
