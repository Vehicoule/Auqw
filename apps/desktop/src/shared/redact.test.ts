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

  // Non-http schemes carry signed queries too — `ws://` is what the
  // desktop sync plane speaks.
  const ws = 'reconnect ws://sync.art.example/v1/socket?sig=SYNTHETIC_SECRET refused';
  assert(!redactSensitive(ws).includes('SYNTHETIC_SECRET'), redactSensitive(ws));
  assert(redactSensitive(ws).includes('sync.art.example/v1/socket'), redactSensitive(ws));

  // Header values run to end of line: `Bearer abc123` is short and a
  // cookie list has several values, so masking one word leaves the rest.
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

  // A bare auth scheme has no length floor, no digit requirement and no
  // case requirement: `bearer abc123` is a credential whatever the
  // casing, and `Token abcDEFghi` is one despite being alphabetic.
  for (const line of [
    'refused Token abcDEFghi',
    'refused ApiKey zyxwvutsrq',
    'refused bearer abc123',
    'refused token xyz',
    'refused basic dXNlcjpwYXNz',
  ]) {
    const masked = redactSensitive(line);
    assert(!masked.includes('abcDEFghi'), masked);
    assert(!masked.includes('zyxwvutsrq'), masked);
    assert(!masked.includes('abc123'), masked);
    assert(!masked.includes('xyz'), masked);
    assert(!masked.includes('dXNlcjpwYXNz'), masked);
  }

  // Secret keys match as a whole segment of the key or as its suffix,
  // so a versioned key is still a key.
  for (const line of [
    'retry with access_token_v2=SYNTHETIC_SECRET now',
    'retry with refresh_token_expiry: SYNTHETIC_SECRET now',
    'retry with api_key=SYNTHETIC_SECRET now',
    'retry with Authorization=SYNTHETIC_SECRET now',
    'retry with signature=SYNTHETIC_SECRET now',
  ]) {
    const masked = redactSensitive(line);
    assert(!masked.includes('SYNTHETIC_SECRET'), masked);
    assert(masked.includes('…'), masked);
  }

  // Quoted JSON keys and the newer auth schemes mask the same: a raw
  // `{"api_key":"..."}` blob and `OAuth ...` are credentials too.
  for (const line of [
    'refused {"access_token":"SYNTHETIC_SECRET"}',
    "refused {'refresh_token':'SYNTHETIC_SECRET'}",
    'refused {"api-key":"SYNTHETIC_SECRET"}',
    'refused Authorization: OAuth SYNTHETIC_SECRET',
    'refused Authorization: Bearer "SYNTHETIC SECRET"',
    'refused with private_token=SYNTHETIC_SECRET now',
  ]) {
    const masked = redactSensitive(line);
    assert(!masked.includes('SYNTHETIC_SECRET'), masked);
  }
  {
    const masked = redactSensitive('refused Authorization: Bearer "SYNTHETIC SECRET" tail');
    assert(!masked.includes('SYNTHETIC SECRET'), masked);
  }

  // A base64 run that STARTS with `/` is a credential, not a path —
  // only a multi-segment slash run keeps its path diagnosis.
  const slashLead = 'failed with /A1b2C3d4E5f6G7h8I9j0K1l2 truncated';
  assert(
    !redactSensitive(slashLead).includes('/A1b2C3d4E5f6G7h8I9j0K1l2'),
    redactSensitive(slashLead),
  );

  // The bare-token case: no surrounding shape at all.
  const bare = 'startup failed with gho_51H8xYzQ3kJ9mNpR7sT2vW4xB6cD';
  assert(
    !redactSensitive(bare).includes('gho_51H8xYzQ3kJ9mNpR7sT2vW4xB6cD'),
    redactSensitive(bare),
  );

  // A slash-bearing key is not a path and must still be masked: it has
  // no leading `/`, no `~/` and no file extension after it.
  const slashy = 'failed with a1B2/c3D4/e5F6/g7H8/i9J0/k1L2 truncated';
  assert(
    !redactSensitive(slashy).includes('a1B2/c3D4/e5F6/g7H8/i9J0/k1L2'),
    redactSensitive(slashy),
  );

  // Diagnostics survive: a path is the single most useful fact in a
  // startup failure, so it keeps a leading slash or a file extension
  // however long and digit-bearing it is.
  for (const line of [
    'EACCES: permission denied, open /Users/me/Library/Application Support/auqw/state-2024.db',
    'ENOENT: no such file /var/folders/ab/cd/T/tmp-12345/auqw-cache',
    'stamped version 0.0.1-alpha.1 failed',
    'the author field was empty',
  ]) {
    assertEqual(redactSensitive(line), line);
  }
  assertEqual(redactSensitive(''), '');

  // A very long input stays bounded in shape and never throws.
  assertEqual(redactSensitive('x'.repeat(10_000)).length, 10_000);
}
