export type DevRoute = 'gallery' | 'seam' | 'journey' | null;

export function devRoute(url: string): DevRoute {
  if (!url.startsWith('auqw://')) {
    return null;
  }
  const verb = url.slice('auqw://'.length).split('?')[0] ?? '';
  if (verb === 'gallery') {
    return 'gallery';
  }
  if (verb.startsWith('seam')) {
    return 'seam';
  }
  return 'journey';
}
