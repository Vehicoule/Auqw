/**
 * Extension → mime for the formats `music-metadata` covers. Shared by
 * the utility's tag/local planes (enumeration, picked-file validation)
 * and the renderer's local-playback attach leg — one table so a type
 * the scanner admits is a type the player names honestly.
 */
export const AUDIO_MIME: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  mp2: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  wv: 'audio/wavpack',
  ape: 'audio/ape',
  mpc: 'audio/x-musepack',
  dsf: 'audio/dsf',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
};

/** The file extension's audio mime, or null for non-audio/none. */
export function mimeForPath(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) {
    return null;
  }
  return AUDIO_MIME[path.slice(dot + 1).toLowerCase()] ?? null;
}
