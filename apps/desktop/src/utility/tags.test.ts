import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assert,
  assertEqual,
} from '@auqw/application/testing';
import { MIGRATIONS } from '@auqw/storage-sqlite';
import { CHANNELS } from '../shared/channels.ts';
import { dirTreeUri, pickedFileTreeUri } from '../shared/local-paths.ts';
import type { UtilityResponse } from './envelope.ts';
import { createUtilityRouter } from './router.ts';
import { createTagService } from './tags.ts';

/**
 * Minimal WAV fixture with RIFF INFO tags — self-contained so the tag
 * read path runs without ffmpeg or a network fixture.
 */
function wavFixture(fields: {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  pcmBytes?: number;
}): Buffer {
  const pcm = Buffer.alloc(fields.pcmBytes ?? 17_640);
  const infoChunks: Buffer[] = [];
  const push = (tag: string, value: string | undefined): void => {
    if (value === undefined) {
      return;
    }
    const data = Buffer.from(value + '\0');
    const chunk = Buffer.alloc(8 + data.length + (data.length % 2));
    chunk.write(tag, 0, 'latin1');
    chunk.writeUInt32LE(data.length, 4);
    data.copy(chunk, 8);
    infoChunks.push(chunk);
  };
  push('INAM', fields.title);
  push('IART', fields.artist);
  push('IPRD', fields.album);
  push('IGNR', fields.genre);
  const info =
    infoChunks.length === 0
      ? Buffer.alloc(0)
      : Buffer.concat([Buffer.from('INFO'), ...infoChunks]);
  const list =
    info.length === 0
      ? Buffer.alloc(0)
      : (() => {
          const head = Buffer.alloc(8);
          head.write('LIST', 0, 'latin1');
          head.writeUInt32LE(info.length, 4);
          return Buffer.concat([head, info, Buffer.alloc(info.length % 2)]);
        })();

  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(2, 10); // stereo
  fmt.writeUInt32LE(44_100, 12);
  fmt.writeUInt32LE(176_400, 16); // byte rate
  fmt.writeUInt16LE(4, 20); // block align
  fmt.writeUInt16LE(16, 22); // bits

  const data = Buffer.alloc(8 + pcm.length);
  data.write('data', 0, 'latin1');
  data.writeUInt32LE(pcm.length, 4);
  pcm.copy(data, 8);

  const body = Buffer.concat([Buffer.from('WAVE'), fmt, list, data]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

export async function run(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'auqw-tags-'));
  const music = join(root, 'music');
  const dbPath = join(root, 'auqw.db');
  const db = new DatabaseSync(dbPath);
  for (const migration of MIGRATIONS) {
    for (const sql of migration) {
      db.exec(sql);
    }
  }
  const service = createTagService({ database: () => db });
  const route = createUtilityRouter(service.handlers);
  let nextId = 1;
  const call = (
    channel: string,
    args?: unknown,
  ): Promise<UtilityResponse> => {
    const id = nextId;
    nextId += 1;
    return route({ id, channel, args });
  };
  const grant = (treeUri: string): void => {
    db.prepare(
      'INSERT INTO local_sources (source_id, tree_uri, label, added_ms) VALUES (?, ?, ?, ?)',
    ).run(`src-${treeUri.length}-${Math.random().toString(36).slice(2)}`, treeUri, 'x', 1);
  };

  try {
    await mkdir(join(music, 'sub'), { recursive: true });
    await writeFile(
      join(music, 'sub', 'track1.wav'),
      wavFixture({
        title: 'Test Tone',
        artist: 'Devin',
        album: 'Fixtures',
        genre: 'Electronic',
        pcmBytes: 17_640,
      }),
    );
    await writeFile(join(music, 'track2.mp3'), Buffer.alloc(1024, 7));
    await writeFile(join(music, 'notes.txt'), 'not audio');

    // Ungranted trees refuse before touching disk.
    const denied = await call(CHANNELS.tagreadEnumerate, {
      treeUri: dirTreeUri(music),
    });
    assert(
      !denied.ok && denied.error?.kind === 'permission-denied',
      'ungranted treeUri is permission-denied',
    );
    grant(dirTreeUri(music));

    const listed = await call(CHANNELS.tagreadEnumerate, {
      treeUri: dirTreeUri(music),
    });
    assert(listed.ok, 'enumerate resolves');
    const entries = (listed.result as { entries: { docId: string; mime: string; size: number }[] })
      .entries;
    assertEqual(
      entries.map((e) => e.docId).join(','),
      'sub/track1.wav,track2.mp3',
      'enumerate walks recursively, sorted, audio only',
    );
    assertEqual(entries[0]?.mime, 'audio/wav', 'mime mapped by ext');

    // docId escapes are refused.
    const escaped = await call(CHANNELS.tagreadFingerprint, {
      treeUri: dirTreeUri(music),
      docIds: ['../outside.wav'],
    });
    assert(
      !escaped.ok && escaped.error?.kind === 'invalid-request',
      'docId escape refused',
    );

    // Fingerprint is stable, move-stable, and content-sensitive.
    const fp1 = await call(CHANNELS.tagreadFingerprint, {
      treeUri: dirTreeUri(music),
      docIds: ['sub/track1.wav', 'track2.mp3', 'gone.wav'],
    });
    assert(fp1.ok, 'fingerprint resolves');
    const fps = (fp1.result as {
      fingerprints: ({ fingerprint: string } | null)[];
    }).fingerprints;
    assert(fps[0] !== null && fps[1] !== null, 'known files fingerprint');
    assertEqual(fps[2], null, 'missing file fingerprints null');
    const fpAgain = await call(CHANNELS.tagreadFingerprint, {
      treeUri: dirTreeUri(music),
      docIds: ['sub/track1.wav'],
    });
    assert(fpAgain.ok, 'second fingerprint resolves');
    assertEqual(
      (fpAgain.result as { fingerprints: { fingerprint: string }[] })
        .fingerprints[0]?.fingerprint,
      fps[0]?.fingerprint,
      'fingerprint is stable across calls',
    );
    await rename(
      join(music, 'sub', 'track1.wav'),
      join(music, 'renamed.wav'),
    );
    const fpMoved = await call(CHANNELS.tagreadFingerprint, {
      treeUri: dirTreeUri(music),
      docIds: ['renamed.wav'],
    });
    assert(fpMoved.ok, 'moved fingerprint resolves');
    assertEqual(
      (fpMoved.result as { fingerprints: { fingerprint: string }[] })
        .fingerprints[0]?.fingerprint,
      fps[0]?.fingerprint,
      'a moved file keeps its fingerprint',
    );

    // Tag read pulls the RIFF INFO fields + real duration.
    const read = await call(CHANNELS.tagreadRead, {
      treeUri: dirTreeUri(music),
      docIds: ['renamed.wav', 'track2.mp3'],
    });
    assert(read.ok, 'read resolves');
    const tags = (read.result as {
      tags: ({
        title: string | null;
        artist: string | null;
        album: string | null;
        genre: string | null;
        durationMs: number | null;
      } | null)[];
    }).tags;
    assertEqual(tags[0]?.title, 'Test Tone', 'INAM → title');
    assertEqual(tags[0]?.artist, 'Devin', 'IART → artist');
    assertEqual(tags[0]?.album, 'Fixtures', 'IPRD → album');
    assertEqual(tags[0]?.genre, 'Electronic', 'IGNR → genre');
    assert(
      tags[0]?.durationMs !== null &&
        tags[0]?.durationMs !== undefined &&
        tags[0].durationMs > 0,
      'duration read from fmt chunk',
    );
    assert(
      tags[1] !== null &&
        tags[1] !== undefined &&
        tags[1].title === null &&
        tags[1].artist === null,
      'tag-less audio maps to null fields, never throws',
    );
    // A docId that resolves nowhere still reads null, not an error.
    const gone = await call(CHANNELS.tagreadRead, {
      treeUri: dirTreeUri(music),
      docIds: ['renamed.wav', 'vanished.wav'],
    });
    assert(
      gone.ok &&
        (gone.result as { tags: (unknown | null)[] }).tags[1] === null,
      'missing doc reads null',
    );

    // The batch bound is enforced at the seam.
    const overBatch = await call(CHANNELS.tagreadFingerprint, {
      treeUri: dirTreeUri(music),
      docIds: Array.from({ length: 65 }, (_, i) => `f${i}.wav`),
    });
    assert(
      !overBatch.ok && overBatch.error?.kind === 'invalid-request',
      'over-bound batch refused',
    );

    // A picked-file tree enumerates exactly its one doc.
    const picked = join(root, 'one.wav');
    await writeFile(picked, wavFixture({ title: 'Solo' }));
    grant(pickedFileTreeUri(picked));
    const single = await call(CHANNELS.tagreadEnumerate, {
      treeUri: pickedFileTreeUri(picked),
    });
    assert(single.ok, 'picked-file enumerate resolves');
    const singleEntries = (single.result as { entries: { docId: string }[] })
      .entries;
    assertEqual(
      singleEntries.length,
      1,
      'picked-file tree enumerates one doc',
    );
    assertEqual(
      singleEntries[0]?.docId,
      'one.wav',
      'docId is the basename',
    );
    const foreignDoc = await call(CHANNELS.tagreadFingerprint, {
      treeUri: pickedFileTreeUri(picked),
      docIds: ['other.wav'],
    });
    assert(
      !foreignDoc.ok && foreignDoc.error?.kind === 'invalid-request',
      'foreign docId refused on picked-file trees',
    );
  } finally {
    service.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}
