import { describe, expect, it } from 'vitest';
import { describeError } from '~/lib/errors';

/**
 * The shape drizzle throws: the statement and every bound parameter in the
 * message, and the thing that actually went wrong on `cause`.
 */
function drizzleError(cause: Error): Error {
  const error = new Error(
    'Failed query: insert into "prospects" ("id", "user_id", "scale_score") values (?, ?, ?)\n' +
      'params: 01M2FBQ98597PTCFRN0YDV4GXW,01M29YA3XT155TWT06GZZJCV3D,0',
  );
  error.cause = cause;
  return error;
}

describe('describeError', () => {
  it('leads with the cause, which is the part that says what broke', () => {
    const message = describeError(
      drizzleError(
        new Error('D1_ERROR: table prospects has no column named scale_score: SQLITE_ERROR'),
      ),
    );

    // The failing run reported only the wrapper, so the reason — a column the
    // database did not have — never reached the page.
    expect(message.startsWith('D1_ERROR: table prospects has no column named scale_score')).toBe(
      true,
    );
    expect(message).toContain('insert into "prospects"');
  });

  it('does not carry the bound parameters into the message', () => {
    // They end up in the campaign's `error` column and on the run page, and
    // they are a prospect's details rather than anything diagnostic.
    const message = describeError(drizzleError(new Error('D1_ERROR: no such column')));
    expect(message).not.toContain('01M2FBQ98597PTCFRN0YDV4GXW');
    expect(message).not.toContain('params:');
  });

  it('walks a chain more than one deep', () => {
    const inner = new Error('connection reset');
    const middle = new Error('fetch failed');
    middle.cause = inner;
    const outer = new Error('Could not publish the demo');
    outer.cause = middle;

    expect(describeError(outer)).toBe(
      'connection reset — while: fetch failed — while: Could not publish the demo',
    );
  });

  it('says a wrapper that only restates its cause once', () => {
    const inner = new Error('quota exceeded');
    const outer = new Error('Model call failed: quota exceeded');
    outer.cause = inner;

    expect(describeError(outer)).toBe(
      'quota exceeded — while: Model call failed: quota exceeded',
    );
  });

  it('copes with whatever else gets thrown', () => {
    expect(describeError('just a string')).toBe('just a string');
    expect(describeError({ message: 'from an object' })).toBe('from an object');
    expect(describeError(null)).toBe('Failed without saying why.');
    expect(describeError(new Error(''))).toBe('Error');
  });

  it('keeps one long message from crowding out the rest', () => {
    const outer = new Error('x'.repeat(5000));
    outer.cause = new Error('the actual reason');

    const message = describeError(outer);
    expect(message.startsWith('the actual reason')).toBe(true);
    expect(message.length).toBeLessThan(600);
  });
});
