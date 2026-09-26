// Android's versionCode is the only ordering PackageManager and Play
// obey: an install is refused unless the incoming code is strictly
// greater than the one already on the device. It is derived from the
// release version rather than maintained beside it — a second
// hand-written number is exactly what goes stale and silently blocks
// upgrades.
//
// Layout `MAJOR*10^7 + MINOR*10^5 + PATCH*10^3 + slot`, with every
// component range-checked so none can bleed into the next:
//
//   major 0..200   minor 0..99   patch 0..99   slot 0..999
//
// `slot` gives each prerelease channel a disjoint ordered band, so a
// channel change always outranks the same version on a lower channel
// and a patch bump always outranks every prerelease of the patch
// before it:
//
//   alpha.N  0 + N     N in 0..332
//   beta.N   333 + N   N in 0..332
//   rc.N     666 + N   N in 0..332
//   stable   999
//
// Peak 200*10^7 + 99*10^5 + 99*10^3 + 999 = 2,009,999,999, under
// Android's 2,100,000,000 ceiling.
//
// A version this cannot order is refused (`null`) rather than guessed:
// `x.y.z` and `x.y.z-<channel>.<n>` are the only shapes whose upgrade
// path is actually known, so an unorderable suffix has to fail the
// stamp instead of minting a code that collides with a real release.

const CHANNEL_BASE = new Map([
  ['alpha', 0],
  ['beta', 333],
  ['rc', 666],
]);

const CHANNEL_MAX = 332;
const STABLE_SLOT = 999;
const MAJOR_MAX = 200;
const MINOR_MAX = 99;
const PATCH_MAX = 99;

const RELEASE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([a-z]+)\.(0|[1-9]\d*))?$/;

const encode = (major, minor, patch, slot) =>
  major * 10_000_000 + minor * 100_000 + patch * 1_000 + slot;

/** Android versionCode for a release version, or null when unorderable. */
export function versionCodeOf(version) {
  const match = RELEASE.exec(version);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const channel = match[4];
  const counter = Number(match[5] ?? '0');
  if (major > MAJOR_MAX || minor > MINOR_MAX || patch > PATCH_MAX) return null;
  if (channel === undefined) {
    return encode(major, minor, patch, STABLE_SLOT);
  }
  const base = CHANNEL_BASE.get(channel);
  if (base === undefined || counter > CHANNEL_MAX) return null;
  return encode(major, minor, patch, base + counter);
}
