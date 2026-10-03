import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '../testing/assert.ts';
import {
  candidateFields,
  consentAllows,
  consentsFromJson,
  consentsToJson,
  describeCandidate,
} from './user-installed.ts';

function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'foo-music',
    version: '1.2.3',
    abi: '0.1.0',
    capabilities: ['catalog.search'],
    permissions: ['network:api.foo.com', 'kv'],
    artifact: {
      path: 'foo.wasm',
      digest: 'sha256:' + 'a'.repeat(64),
    },
    ...overrides,
  });
}

function b64(text: string): string {
  // Tiny inline base64 (test-only, ASCII input).
  const B64 =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let bin = '';
  for (let i = 0; i < text.length; i++) {
    bin += text.charCodeAt(i).toString(2).padStart(8, '0');
  }
  let enc = '';
  for (let i = 0; i < bin.length; i += 6) {
    const chunk = bin.slice(i, i + 6).padEnd(6, '0');
    enc += B64[parseInt(chunk, 2)];
  }
  while (enc.length % 4 !== 0) {
    enc += '=';
  }
  return enc;
}

const WASM_B64 = b64('magic wasm bytes');

function candidate(overrides: Record<string, unknown> = {}) {
  return describeCandidate({
    manifestJson: manifestJson(overrides),
    wasmB64: WASM_B64,
  });
}

type Desc = NonNullable<ReturnType<typeof describeCandidate>>;

function consentFor(desc: Desc) {
  return {
    id: desc.fields.id,
    version: desc.fields.version,
    abi: desc.fields.abi,
    wasm_sha256: desc.wasm_sha256,
    manifest_sha256: desc.manifest_sha256,
    approved_permissions: [...desc.fields.permissions],
  };
}

export async function run(): Promise<void> {
  // describeCandidate: well-formed pair describes; malformed refuses.
  const desc = candidate();
  assert(desc !== null, 'well-formed candidate describes');
  assertEqual(candidateFields('not json'), null, 'malformed manifest refuses');
  assertEqual(
    describeCandidate({ manifestJson: manifestJson(), wasmB64: '!!' }),
    null,
    'bad base64 wasm refuses',
  );
  assertEqual(
    describeCandidate({ manifestJson: manifestJson(), wasmB64: '' }),
    null,
    'empty wasm refuses',
  );

  // The consent gate: exact pin allows; anything else refuses.
  const consent = consentFor(desc);
  assert(
    consentAllows(desc, [consent]),
    'matching record allows the exact pair',
  );
  assert(
    !consentAllows(desc, []),
    'no records refuses everything',
  );

  const descNewBytes = describeCandidate({
    manifestJson: manifestJson(),
    wasmB64: b64('different bytes'),
  });
  assert(descNewBytes !== null, 'different-bytes candidate describes');
  assert(
    !consentAllows(descNewBytes, [consent]),
    'different wasm bytes require fresh consent',
  );

  const descNewPerm = candidate({
    permissions: ['network:api.foo.com', 'kv', 'pot-provider'],
  });
  assert(
    !consentAllows(descNewPerm, [consent]),
    'a manifest the record never approved refuses',
  );

  const reordered = {
    ...consent,
    approved_permissions: [...consent.approved_permissions].reverse(),
  };
  assert(
    consentAllows(desc, [reordered]),
    'permission order does not matter',
  );

  assert(
    !consentAllows(desc, [{ ...consent, id: 'other' }]),
    'identity pin refuses foreign records',
  );

  // Persistence round-trip.
  const parsed = consentsFromJson(consentsToJson([consent]));
  assertEqual(parsed.length, 1, 'round-trip preserves the record');
  assert(
    consentAllows(desc, parsed),
    'parsed record still allows',
  );
  assertDeepEqual(consentsFromJson('nope'), [], 'malformed store yields []');
  assertDeepEqual(
    consentsFromJson('{"consents": [{"id": 3}]}'),
    [],
    'malformed entry is dropped, not fatal',
  );

  // candidateFields guards.
  assertEqual(
    candidateFields(manifestJson({ id: '' })),
    null,
    'empty id refuses',
  );
  assertEqual(
    candidateFields(manifestJson({ permissions: 'network:x' })),
    null,
    'non-array permissions refuses',
  );
  assertEqual(
    candidateFields(manifestJson({ permissions: ['ok', 5] })),
    null,
    'non-string permission entry refuses',
  );
}
