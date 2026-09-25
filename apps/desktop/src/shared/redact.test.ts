import { assert, assertEqual } from '@auqw/application/testing';
import { redactSensitive } from './redact.ts';

export async function run(): Promise<void> {
  // A signed URL keeps its diagnosis (host + path) and loses the secret
  // in the query and fragment, plus any userinfo.
  const signed =
    'GET https://user:pass@cdn.art.example/covers/a1b2.jpg?sig=SYNTHETIC_SECRET&exp=9#frag failed';
  const maskedUrl = redactSensitive(signed);
  assert(maskedUrl.includes('cdn.art.example/covers/a1b2.jpg'), maskedUrl);
  assert(!maskedUrl.includes('SYNTHETIC_SECRET'), maskedUrl);
  assert(!maskedUrl.includes('user:pass'), maskedUrl);
  assert(!maskedUrl.includes('frag'), maskedUrl);

  // Authorization-style credentials go wholesale.
  for (const line of [
    'refused header Authorization: Bearer SYNTHETIC_SECRET',
    'refused header Authorization: Basic SYNTHETIC_SECRET',
    'refused header Token SYNTHETIC_SECRET',
  ]) {
    const masked = redactSensitive(line);
    assert(!masked.includes('SYNTHETIC_SECRET'), masked);
  }

  // Keyed secrets lose the value and keep the key, so the log still
  // says which credential failed.
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

  // Ordinary diagnostics must survive recognisably: English, a path and
  // a version are not credentials and must not be mangled.
  const ordinary =
    'EACCES: permission denied, open /Users/me/Library/Logs/auqw.log in createSecureStore';
  assertEqual(redactSensitive(ordinary), ordinary);
  assertEqual(
    redactSensitive('stamped version 0.0.1-alpha.1 failed'),
    'stamped version 0.0.1-alpha.1 failed',
  );
  assertEqual(redactSensitive(''), '');

  // A very long input stays bounded in shape and never throws.
  const long = redactSensitive('x'.repeat(10_000));
  assertEqual(long.length, 10_000, 'plain text is left intact');
}
