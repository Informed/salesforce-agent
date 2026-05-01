import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  deriveRuntimeSessionId,
  isValidRuntimeSessionId,
  RUNTIME_SESSION_ID_MAX_LEN,
} from '../../agent/runtime-session-id.js';

describe('runtime-session-id', () => {
  it('deriveRuntimeSessionId is stable for the same inputs', () => {
    const a = deriveRuntimeSessionId('C0123', '1234.5678');
    const b = deriveRuntimeSessionId('C0123', '1234.5678');
    assert.strictEqual(a, b);
  });

  it('deriveRuntimeSessionId differs when channel or thread changes', () => {
    const a = deriveRuntimeSessionId('C0123', '1234.5678');
    const b = deriveRuntimeSessionId('C0123', '1234.5679');
    const c = deriveRuntimeSessionId('C0999', '1234.5678');
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a, c);
  });

  it('deriveRuntimeSessionId satisfies harness length and pattern', () => {
    const id = deriveRuntimeSessionId('C0ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', '9999999999.999999');
    assert.ok(id.length <= RUNTIME_SESSION_ID_MAX_LEN);
    assert.ok(isValidRuntimeSessionId(id));
  });

  it('isValidRuntimeSessionId rejects empty, too long, and bad characters', () => {
    assert.strictEqual(isValidRuntimeSessionId(''), false);
    assert.strictEqual(isValidRuntimeSessionId(null), false);
    assert.strictEqual(isValidRuntimeSessionId(undefined), false);
    assert.strictEqual(isValidRuntimeSessionId('a.b'), false);
    assert.strictEqual(isValidRuntimeSessionId('x'.repeat(101)), false);
    assert.strictEqual(isValidRuntimeSessionId('sabc'), true);
  });
});
