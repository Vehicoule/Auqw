import { assert } from '@auqw/application/testing';
import * as v from './schema.ts';

export function run(): void {
  // string — empty allowed, optional length cap
  assert(v.string()(''), 'string accepts empty');
  assert(v.string()('x'), 'string accepts value');
  assert(!v.string()(7), 'string rejects non-string');
  assert(v.string(3)('abc'), 'string at cap passes');
  assert(!v.string(3)('abcd'), 'string over cap rejected');
  assert(v.boundedString(3)('x'), 'boundedString passes');
  assert(!v.boundedString(3)(''), 'boundedString rejects empty');
  assert(!v.boundedString(3)('abcd'), 'boundedString over cap rejected');
  assert(v.pattern(/^a+$/)('aaa'), 'pattern passes');
  assert(!v.pattern(/^a+$/)('aba'), 'pattern rejects mismatch');
  assert(!v.pattern(/^a+$/)(1), 'pattern rejects non-string');

  // boolean / numbers
  assert(v.boolean()(true), 'boolean passes');
  assert(!v.boolean()(0), 'boolean rejects 0');
  assert(v.int()(0), 'int accepts zero');
  assert(v.int()(42), 'int accepts positive');
  assert(!v.int()(-1), 'int rejects negative');
  assert(!v.int()(1.5), 'int rejects fractional');
  assert(v.int(10)(10), 'int at bound passes');
  assert(!v.int(10)(11), 'int over bound rejected');
  assert(v.integer()(-7), 'integer accepts negative');
  assert(v.integer()(0), 'integer accepts zero');
  assert(!v.integer()(1.5), 'integer rejects fractional');
  assert(!v.integer()(Number.NaN), 'integer rejects NaN');
  assert(v.finite()(-2.5), 'finite accepts negative float');
  assert(!v.finite()(Number.NaN), 'finite rejects NaN');
  assert(!v.finite()(Infinity), 'finite rejects Infinity');

  // literals
  assert(v.literal('x')('x'), 'literal passes');
  assert(!v.literal('x')('y'), 'literal rejects other');
  assert(v.literal(null)(null), 'literal null passes');
  assert(!v.literal(null)(undefined), 'literal null rejects undefined');
  assert(v.literal(undefined)(undefined), 'literal undefined passes');
  assert(!v.literal(undefined)(null), 'literal undefined rejects null');
  assert(v.literals('a', 'b')('b'), 'literals member passes');
  assert(!v.literals('a', 'b')('c'), 'literals rejects non-member');

  // nullable
  const nullableStr = v.nullable(v.string());
  assert(nullableStr(null), 'nullable accepts null');
  assert(nullableStr('x'), 'nullable accepts inner');
  assert(!nullableStr(undefined), 'nullable rejects undefined');
  assert(!nullableStr(1), 'nullable rejects wrong type');

  // array bounds
  const strArr = v.array(v.string());
  assert(strArr([]), 'array accepts empty');
  assert(strArr(['a', 'b']), 'array accepts items');
  assert(!strArr(['a', 1]), 'array rejects bad item');
  assert(!strArr('ab'), 'array rejects non-array');
  const bounded = v.array(v.int(), { min: 1, max: 2 });
  assert(!bounded([]), 'array under min rejected');
  assert(bounded([1]), 'array at min passes');
  assert(bounded([1, 2]), 'array at max passes');
  assert(!bounded([1, 2, 3]), 'array over max rejected');

  // object — strict keys, required vs optional
  const rec = v.object({
    id: v.boundedString(10),
    count: v.optional(v.int()),
  });
  assert(rec({ id: 'x' }), 'object with optional absent passes');
  assert(rec({ id: 'x', count: 3 }), 'object with optional set passes');
  assert(
    rec({ id: 'x', count: undefined }),
    'explicit undefined optional passes',
  );
  assert(!rec({ count: 3 }), 'missing required key rejected');
  assert(!rec({ id: 'x', extra: 1 }), 'unknown key rejected');
  assert(!rec({ id: 'x', count: 'n' }), 'wrong optional type rejected');
  assert(!rec(null), 'null rejected');
  assert(!rec([]), 'array rejected as object');
  assert(!rec('x'), 'non-record rejected');

  // union
  const u = v.union(v.object({ k: v.literal('a') }), v.object({ k: v.literal('b'), n: v.int() }));
  assert(u({ k: 'a' }), 'union variant a passes');
  assert(u({ k: 'b', n: 1 }), 'union variant b passes');
  assert(!u({ k: 'b' }), 'partial variant rejected');
  assert(!u({ k: 'c' }), 'union rejects non-member');
  assert(!u(5), 'union rejects non-record');

  // refine — extra rule, same narrowing
  const noPrefix = v.refine(v.string(), (s) => !s.startsWith('x'));
  assert(noPrefix('abc'), 'refine passes');
  assert(!noPrefix('xyz'), 'refine rejects on check');
  assert(!noPrefix(5), 'refine keeps inner rejection');

  // checked — acceptance without narrowing
  const opaque = v.checked((value) => typeof value === 'object');
  assert(opaque({}), 'checked accepts per predicate');
  assert(!opaque(1), 'checked rejects per predicate');
}
