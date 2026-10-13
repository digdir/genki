import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createPool } from './pool.js';

describe('createPool', () => {
  it('keeps a server error on a closing client from crashing the process', async () => {
    const pool = createPool({ host: '127.0.0.1' });
    const client = new EventEmitter();
    pool.emit('connect', client);

    expect(() => client.emit('error', new Error('terminating connection'))).not.toThrow();
    await pool.end();
  });
});
