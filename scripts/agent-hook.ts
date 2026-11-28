import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, ftruncateSync, openSync, readFileSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  git,
  gitleaksMissing,
  gitleaksStep,
  hasCommand,
  hasOwnChanges,
  mergeBase,
  readStamp,
  stampFresh,
  workingTree,
} from './verify.ts';
import { npmCommand } from './setup.ts';

export interface HookInput {
  cwd?: string;
  tool_name?: string;
  tool_input?: { command?: string; file_path?: string };
  stop_hook_active?: boolean;
}

export interface Decision {
  code: 0 | 2;
  stderr?: string;
  stdout?: string;
}

export interface TreeState {
  ownChanges: boolean;
  fresh: boolean;
}

const allow: Decision = { code: 0 };
const staleMessage = 'run npm run verify: the verify stamp does not match the working tree';

export const agentHooksOff = (env: NodeJS.ProcessEnv) => env.GITHUB_ACTIONS === 'true';

export const stopDecision = (state: TreeState, stopHookActive: boolean): Decision => {
  if (!state.ownChanges || state.fresh) return allow;
  if (stopHookActive)
    return {
      code: 0,
      stdout: JSON.stringify({
        systemMessage:
          'Stopped with a stale verify stamp: npm run verify has not passed on this tree.',
      }),
    };
  return { code: 2, stderr: staleMessage };
};

const gitSubcommand = (words: string[], start: number) => {
  let at = start + 1;
  while (words[at]?.startsWith('-')) at += words[at] === '-C' || words[at] === '-c' ? 2 : 1;
  return words[at];
};

const pushesOrOpensPr = (segment: string) => {
  const words = segment.trim().split(/\s+/);
  let at = 0;
  while (words[at] !== undefined && /^\w+=/.test(words[at] ?? '')) at += 1;
  if (words[at] === 'git') return gitSubcommand(words, at) === 'push';
  return words[at] === 'gh' && words[at + 1] === 'pr' && words[at + 2] === 'create';
};

export const isPushCommand = (command: string) => command.split(/[;&|(\n]/).some(pushesOrOpensPr);

export const bashDecision = (command: string, state: TreeState): Decision =>
  isPushCommand(command) && state.ownChanges && !state.fresh
    ? { code: 2, stderr: `${staleMessage}, so git push and gh pr create are blocked` }
    : allow;

export interface PushedRef {
  localRef: string;
  localSha: string;
}

export const parsePushedRefs = (stdin: string): PushedRef[] =>
  stdin
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 4)
    .map(([localRef = '', localSha = '']) => ({ localRef, localSha }))
    .filter((ref) => !/^0+$/.test(ref.localSha) && !ref.localRef.startsWith('refs/tags/'));

export type PrePush = 'allow' | 'verify' | 'dirty';

export const prePushDecision = (
  pushedTrees: string[],
  stamp: string | undefined,
  tree: string,
): PrePush => {
  const distinct = new Set(pushedTrees);
  if ([...distinct].every((pushed) => stampFresh(stamp, pushed))) return 'allow';
  return distinct.size === 1 && distinct.has(tree) ? 'verify' : 'dirty';
};

const treeState = (root: string): TreeState => {
  const base = mergeBase(root);
  if (!base) return { ownChanges: false, fresh: true };
  const tree = workingTree(root);
  return { ownChanges: hasOwnChanges(root, base, tree), fresh: stampFresh(readStamp(root), tree) };
};

const repoOf = (dir: string): string | undefined => {
  try {
    const root = git(dir, ['rev-parse', '--show-toplevel']);
    return existsSync(join(root, 'scripts', 'verify.ts')) ? root : undefined;
  } catch {
    return undefined;
  }
};

const formatFile = async (root: string, file: string) => {
  const path = isAbsolute(file) ? file : resolve(root, file);
  if (relative(root, path).startsWith('..')) return;
  let fd: number;
  try {
    fd = openSync(path, 'r+');
  } catch {
    return;
  }
  try {
    const prettier = await import('prettier');
    const info = await prettier.getFileInfo(path, {
      ignorePath: [join(root, '.gitignore'), join(root, '.prettierignore')],
    });
    if (info.ignored || !info.inferredParser) return;
    const source = readFileSync(fd, 'utf8');
    const options = await prettier.resolveConfig(path);
    const formatted = await prettier.format(source, { ...options, filepath: path });
    if (formatted === source) return;
    ftruncateSync(fd);
    writeSync(fd, formatted, 0);
  } finally {
    closeSync(fd);
  }
};

const prePush = (root: string, stdin: string): number => {
  const refs = parsePushedRefs(stdin);
  const trees = refs.map((ref) => git(root, ['rev-parse', `${ref.localSha}^{tree}`]));
  const decision = prePushDecision(trees, readStamp(root), workingTree(root));
  if (decision === 'dirty') {
    console.error(
      'pre-push: what you push is not the working tree, so npm run verify cannot check it. Commit or set aside the other changes and push again. git push --no-verify skips this, for emergencies only.',
    );
    return 1;
  }
  if (decision === 'verify') {
    const npm = npmCommand(['run', 'verify']);
    const result = spawnSync(npm.command, npm.args, { cwd: root, stdio: 'inherit' });
    return result.status ?? 1;
  }
  if (!hasCommand('gitleaks')) {
    console.warn(gitleaksMissing);
    return 0;
  }
  for (const sha of new Set(refs.map((ref) => ref.localSha))) {
    const step = gitleaksStep(`origin/main..${sha}`);
    if (spawnSync(step.command, step.args, { cwd: root, stdio: 'inherit' }).status !== 0) return 1;
  }
  return 0;
};

const readStdin = () => {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};

const emit = (decision: Decision) => {
  if (decision.stdout) process.stdout.write(`${decision.stdout}\n`);
  if (decision.stderr) process.stderr.write(`${decision.stderr}\n`);
  process.exit(decision.code);
};

const main = async () => {
  const mode = process.argv[2];
  const stdin = readStdin();
  if (mode === 'pre-push') process.exit(prePush(repoOf(process.cwd()) ?? process.cwd(), stdin));
  const input = JSON.parse(stdin || '{}') as HookInput;
  const root = repoOf(input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  if (!root || agentHooksOff(process.env)) return emit(allow);
  if (mode === 'post-edit') {
    if (input.tool_input?.file_path)
      await formatFile(root, input.tool_input.file_path).catch(() => {});
    return emit(allow);
  }
  if (mode === 'stop') return emit(stopDecision(treeState(root), input.stop_hook_active === true));
  if (mode === 'bash') {
    const command = input.tool_input?.command ?? '';
    return emit(isPushCommand(command) ? bashDecision(command, treeState(root)) : allow);
  }
  emit(allow);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
