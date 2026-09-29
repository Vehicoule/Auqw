export function devRoute(
  url: string,
): 'gallery' | 'seam' | 'journey' | null {
  if (!url.startsWith('auqw://')) {
    return null;
  }
  const verb = url.slice('auqw://'.length).split('?')[0] ?? '';
  if (verb === 'gallery') {
    return 'gallery';
  }
  return verb.startsWith('seam') ? 'seam' : 'journey';
}
