import { assert, assertEqual } from '@auqw/application/testing';
import { redactSensitive } from './redact.ts';

export async function run(): Promise<void> {
  // A signed URL keeps its diagnosis (host + path) and loses the query,
  // fragment and userinfo.
  const signed =
    'GET https://user:pass@cdn.art.example/covers/a1b2.jpg?sig=SYNTHETIC_SECRET&exp=9#frag failed';
  const maskedUrl = redactSensitive(signed);
  assert(maskedUrl.includes('cdn.art.example/covers/a1b2.jpg'), maskedUrl);
  assert(!maskedUrl.includes('SYNTHETIC_SECRET'), maskedUrl);
  assert(!maskedUrl.includes('user:pass'), maskedUrl);
  assert(!maskedUrl.includes('frag'), maskedUrl);

  // Non-http schemes carry signed queries too — `ws://` is the review's
  // example, and the desktop sync plane speaks it.
  const ws = 'reconnect ws://sync.art.example/v1/socket?sig=SYNTHETIC_SECRET refused';
  assert(!redactSensitive(ws).includes('SYNTHETIC_SECRET'), redactSensitive(ws));
  assert(redactSensitive(ws).includes('sync.art.example/v1/socket'), redactSensitive(ws));

  // Header values run to end of line: `Bearer abc123` is short, and a
  // cookie list has several values — masking the first word leaves the
  // rest exposed.
  for (const line of [
    'refused Authorization: Bearer abc123',
    'refused Authorization: Bearer SYNTHETIC_SECRET',
    'refused Authorization: Basic SYNTHETIC_SECRET',
    'refused Cookie: sid=SYNTHETIC_SECRET; refresh=SYNTHETIC_SECRET',
  ]) {
    const masked = redactSensitive(line);
    assert(!masked.includes('SYNTHETIC_SECRET'), masked);
    assert(!masked.includes('abc123'), masked);
  }

  // Keyed secrets lose the value and keep the key, so the log still
  // names which credential failed. `Authorization=` covers the `=` form
  // the header rule does not.
  for (const line of [
    'retry with api_key=SYNTHETIC_SECRET now',
    'retry with access_token: SYNTHETIC_SECRET now',
    'retry with Authorization=SYNTHETIC_SECRET now',
  ]) {
    const masked = redactSensitive(line);
    assert(!masked.includes('SYNTHETIC_SECRET'), masked);
    assert(masked.includes('…'), masked);
  }

  // The case the review named: a bare token with no surrounding shape.
  const bare = 'startup failed with gho_51H8xYzQ3kJ9mNpR7sT2vW4xB6cD';
  assert(
    !redactSensitive(bare).includes('gho_51H8xYzQ3kJ9mNpR7sT2vW4xB6cD'),
    redactSensitive(bare),
  );

  // Diagnostics must survive: a path is the single most useful fact in
  // a startup failure, so it is never masked even when it is long and
  // digit-bearing. So are English words and version strings.
  for (const line of [
    'EACCES: permission denied, open /Users/me/Library/Application Support/auqw/state-2024.db',
    'stamped version 0.0.1-alpha.1 failed',
    'the author field was empty',
  ]) {
    assertEqual(redactSensitive(line), line);
  }
  assertEqual(redactSensitive(''), '');

  // A very long input stays bounded in shape and never throws.
  assertEqual(redactSensitive('x'.repeat(10_000)).length, 10_000);
}
