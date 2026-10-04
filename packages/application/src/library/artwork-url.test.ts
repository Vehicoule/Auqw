import { assert, assertEqual } from '../testing/assert.ts';
import { artworkAssetKey, artworkUrlSize } from './artwork-url.ts';

// The CDN size grammar's reverse read: asset key strips the knob to
// identity, url size parses the served edge back out. scaledArtworkUrl
// itself is covered through the ui-shared suite (re-export keeps its
// import path); these pin the sibling-reuse contract the artwork
// cache depends on.
export function run(): void {
  // googleusercontent `=wN-hN` — flags are part of the asset, size is not.
  const g = (n: number) =>
    `https://lh3.googleusercontent.com/img/abc=w${n}-h${n}-l90-rj`;
  assertEqual(artworkAssetKey(g(128)), artworkAssetKey(g(1024)));
  assertEqual(artworkAssetKey(g(128)), 'https://lh3.googleusercontent.com/img/abc-l90-rj');
  assert(artworkAssetKey(g(128)) !== artworkAssetKey('https://lh3.googleusercontent.com/img/zzz=w128-h128-l90-rj'));
  // Flags differ → different asset (crop/quality marks aren't sizes).
  assert(artworkAssetKey(g(128)) !== artworkAssetKey('https://lh3.googleusercontent.com/img/abc=w128-h128-c-k'));
  assertEqual(artworkUrlSize(g(544)), 544);
  // `=sN` square knob, same treatment.
  const s = (n: number) => `https://yt3.ggpht.com/abc=s${n}-c-k`;
  assertEqual(artworkAssetKey(s(64)), artworkAssetKey(s(900)));
  assertEqual(artworkUrlSize(s(900)), 900);
  // Bare google path: no knob → url is its own key; size = the
  // documented ~900px default.
  const bare = 'https://lh3.googleusercontent.com/img/abc';
  assertEqual(artworkAssetKey(bare), bare);
  assertEqual(artworkUrlSize(bare), 900);
  // ...and a bare path keys alike with its appended-size variants.
  assertEqual(artworkAssetKey(`${bare}=w128-h128`), bare);
  // Deezer/iTunes `NxN` tails — flags and extension kept.
  const d = (n: number) =>
    `https://e-cdns-images.dzcdn.net/images/cover/abc/${n}x${n}.jpg`;
  assertEqual(artworkAssetKey(d(64)), artworkAssetKey(d(500)));
  assertEqual(artworkUrlSize(d(500)), 500);
  const mz = (n: number) => `https://is1.mzstatic.com/image/abc/${n}x${n}bb.jpg`;
  assertEqual(artworkAssetKey(mz(128)), artworkAssetKey(mz(3000)));
  assertEqual(artworkUrlSize(mz(3000)), 3000);
  // Non-square `NxM` is not a size knob — key and size both refuse it.
  const rect = 'https://cdn.example/art/600x400.jpg';
  assertEqual(artworkAssetKey(rect), rect);
  assertEqual(artworkUrlSize(rect), null);
  // Look-alike hosts don't take the google grammar.
  const evil = 'https://ggpht.com.evil.tld/img=w128-h128';
  assertEqual(artworkAssetKey(evil), evil);
  assertEqual(artworkUrlSize(evil), null);
  // Plain urls have no knob anywhere.
  assertEqual(artworkAssetKey('https://art.example/a.jpg'), 'https://art.example/a.jpg');
  assertEqual(artworkUrlSize('https://art.example/a.jpg'), null);
}
