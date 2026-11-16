import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { keepRunningOnRejection } from './process-guard.js';

const setup = () => {
  const target = Object.assign(new EventEmitter(), { exit: vi.fn() });
  const lines: { msg: string; fields: Record<string, unknown> }[] = [];
  keepRunningOnRejection(
    (msg, fields) => lines.push({ msg, fields }),
    target as unknown as Pick<NodeJS.Process, 'on' | 'exit'>,
  );
  return { target, lines };
};

describe('keeping the process running on an unhandled rejection', () => {
  it('an unhandled rejection is logged and does not end the process', () => {
    const { target, lines } = setup();
    target.emit('unhandledRejection', new TypeError('boom'));
    expect(target.exit).not.toHaveBeenCalled();
    expect(lines).toEqual([
      { msg: 'unhandled promise rejection', fields: { error: 'TypeError', count: 1 } },
    ]);
  });

  it('counts the rejections it has seen', () => {
    const { target, lines } = setup();
    target.emit('unhandledRejection', new Error('a'));
    target.emit('unhandledRejection', 'text');
    expect(lines.map((l) => l.fields.count)).toEqual([1, 2]);
  });

  it('the log carries the error name and code but never its message', () => {
    const { target, lines } = setup();
    const error = Object.assign(new Error('sk-secret 01017012345 Kari Nordmann'), {
      code: 'ECONNRESET',
    });
    target.emit('unhandledRejection', error);
    expect(JSON.stringify(lines)).not.toMatch(/secret|01017012345|Kari/);
    expect(lines[0]?.fields).toMatchObject({ error: 'Error', code: 'ECONNRESET' });
  });

  it('an uncaught exception is logged and ends the process, since its state is unknown', () => {
    const { target, lines } = setup();
    target.emit('uncaughtException', new Error('broken'));
    expect(lines[0]?.msg).toBe('uncaught exception, exiting');
    expect(target.exit).toHaveBeenCalledWith(1);
  });
});
