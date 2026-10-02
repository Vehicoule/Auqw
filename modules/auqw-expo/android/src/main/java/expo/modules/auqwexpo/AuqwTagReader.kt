package expo.modules.auqwexpo

import android.content.Context
import android.content.Intent
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import java.security.MessageDigest

/**
 * TagReaderPort backing (slice 3): SAF tree enumeration, content
 * fingerprints, and MediaMetadataRetriever tag reads. Platform URI
 * math (buildDocumentUriUsingTree) lives here so the application
 * layer never constructs content:// strings.
 *
 * Batched surfaces (fingerprint/readTags) keep the JSI round-trip
 * flat at library scale — a ≥200-file folder must not pay a bridge
 * call per file.
 */
object AuqwTagReader {

  private const val TAG = "AuqwTagReader"
  const val PICK_REQUEST_CODE = 0x4157 // "AW"

  /** Sampled bytes at head and tail of the file for the fingerprint. */
  private const val SAMPLE = 4096

  private fun docUri(treeUri: Uri, docId: String): Uri =
    DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)

  /** Take the persistable read grant and resolve a display label. */
  fun persistAndLabel(ctx: Context, treeUri: Uri): Pair<String, String> {
    try {
      ctx.contentResolver.takePersistableUriPermission(
        treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION
      )
    } catch (e: SecurityException) {
      // Some providers return trees that can't persist — keep the row
      // honest: enumerate will surface permission-denied later.
      Log.w(TAG, "persistable grant refused: ${e.message}")
    }
    val treeDocId = DocumentsContract.getTreeDocumentId(treeUri)
    val label = try {
      ctx.contentResolver.query(
        docUri(treeUri, treeDocId),
        arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
        null, null, null
      )?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    } catch (e: Exception) {
      null
    } ?: treeDocId
    return treeUri.toString() to label
  }

  /**
   * Depth-first walk of the tree. Yields entries for files whose mime
   * is audio/<subtype> (or unknown-but-audio-looking); directories recurse.
   */
  fun enumerate(ctx: Context, treeUri: Uri): List<Map<String, Any?>> {
    val out = mutableListOf<Map<String, Any?>>()
    val stack = ArrayDeque<String>()
    stack.add(DocumentsContract.getTreeDocumentId(treeUri))
    while (stack.isNotEmpty()) {
      val parentId = stack.removeLast()
      val children = DocumentsContract.buildChildDocumentsUriUsingTree(
        treeUri, parentId
      )
      val cursor = ctx.contentResolver.query(
        children,
        arrayOf(
          DocumentsContract.Document.COLUMN_DOCUMENT_ID,
          DocumentsContract.Document.COLUMN_DISPLAY_NAME,
          DocumentsContract.Document.COLUMN_SIZE,
          DocumentsContract.Document.COLUMN_MIME_TYPE,
          DocumentsContract.Document.COLUMN_LAST_MODIFIED
        ),
        null, null, null
      ) ?: continue
      cursor.use {
        while (it.moveToNext()) {
          val docId = it.getString(0) ?: continue
          val name = it.getString(1) ?: continue
          val size = if (it.isNull(2)) 0L else it.getLong(2)
          val mime = it.getString(3) ?: ""
          // Providers can legally report no stamp — null keeps the
          // scan's fingerprint fallback honest for them.
          val modifiedMs = if (it.isNull(4)) null else it.getLong(4)
          if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
            stack.add(docId)
          } else if (mime.startsWith("audio/") || looksAudio(name)) {
            out.add(
              mapOf(
                "docId" to docId,
                "name" to name,
                "size" to size.toDouble(),
                "mime" to mime,
                "modifiedMs" to modifiedMs?.toDouble()
              )
            )
          }
        }
      }
    }
    return out
  }

  private fun looksAudio(name: String): Boolean {
    val lower = name.lowercase()
    return lower.endsWith(".mp3") || lower.endsWith(".m4a") ||
      lower.endsWith(".flac") || lower.endsWith(".ogg") ||
      lower.endsWith(".opus") || lower.endsWith(".wav") ||
      lower.endsWith(".aac") || lower.endsWith(".wma")
  }

  /** Per-doc batch: null per entry on failure so the batch survives
   * one bad file. */
  private fun perDoc(
    docIds: List<String>,
    op: String,
    each: (String) -> Map<String, Any?>
  ): List<Map<String, Any?>?> =
    docIds.map { docId ->
      try {
        each(docId)
      } catch (e: Exception) {
        Log.w(TAG, "$op failed for $docId: ${e.message}")
        null
      }
    }

  /**
   * sha256(head 4KiB || tail 4KiB || sizeLE) per doc; null per entry
   * on open/read failure so the batch survives one bad file.
   */
  fun fingerprint(
    ctx: Context,
    treeUri: Uri,
    docIds: List<String>
  ): List<Map<String, Any?>?> =
    perDoc(docIds, "fingerprint") { fingerprintOne(ctx, treeUri, it) }

  private fun fingerprintOne(
    ctx: Context,
    treeUri: Uri,
    docId: String
  ): Map<String, Any?> {
    val uri = docUri(treeUri, docId)
    val digest = MessageDigest.getInstance("SHA-256")
    var size = 0L
    ctx.contentResolver.openFileDescriptor(uri, "r").use { pfd ->
      val fd = pfd ?: throw java.io.IOException("no fd")
      java.io.FileInputStream(fd.fileDescriptor).channel.use { ch ->
        size = ch.size()
        val head = ByteArray(minOf(SAMPLE.toLong(), size).toInt())
        val tail = ByteArray(
          maxOf(0L, size - head.size).coerceAtMost(SAMPLE.toLong()).toInt()
        )
        digest.update(head, 0, fill(ch, head))
        if (tail.isNotEmpty()) {
          ch.position(size - tail.size)
          digest.update(tail, 0, fill(ch, tail))
        }
      }
    }
    val sizeBytes = java.nio.ByteBuffer.allocate(8)
      .order(java.nio.ByteOrder.LITTLE_ENDIAN)
      .putLong(size).array()
    digest.update(sizeBytes)
    val hex = digest.digest().joinToString("") { "%02x".format(it) }
    return mapOf("docId" to docId, "fingerprint" to hex)
  }

  /** Read `dst` end-to-end; returns the consumed byte count (short at EOF). */
  private fun fill(ch: java.nio.channels.FileChannel, dst: ByteArray): Int {
    val buf = java.nio.ByteBuffer.wrap(dst)
    while (buf.hasRemaining() && ch.read(buf) >= 0) {}
    return buf.position()
  }

  /** MediaMetadataRetriever tags per doc; null per-entry on failure. */
  fun readTags(
    ctx: Context,
    treeUri: Uri,
    docIds: List<String>
  ): List<Map<String, Any?>?> =
    perDoc(docIds, "readTags") { tagsOne(ctx, treeUri, it) }

  private fun tagsOne(
    ctx: Context,
    treeUri: Uri,
    docId: String
  ): Map<String, Any?> {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(ctx, docUri(treeUri, docId))
      fun meta(key: Int) = retriever.extractMetadata(key)
      val duration = meta(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
      return mapOf(
        "docId" to docId,
        "title" to meta(MediaMetadataRetriever.METADATA_KEY_TITLE),
        "artist" to meta(MediaMetadataRetriever.METADATA_KEY_ARTIST),
        "album" to meta(MediaMetadataRetriever.METADATA_KEY_ALBUM),
        "durationMs" to duration?.toDouble()?.takeIf { it > 0 },
        "genre" to meta(MediaMetadataRetriever.METADATA_KEY_GENRE),
        "artworkUri" to artworkUri(ctx, retriever.embeddedPicture)
      )
    } finally {
      retriever.release()
    }
  }

  /**
   * Embedded cover → the content-addressed art store under
   * `filesDir/art/`. The bytes' sha256 names the file, so identical
   * covers across tracks land once and an existing file skips the
   * write. Original bytes go to disk un-resized — the UI downscales
   * GPU-side, and filesDir keeps art alive as long as the recordings
   * table does (a cacheDir reaping would strand artwork permanently:
   * unchanged docs never re-read tags). `file://` refs render
   * directly — the artwork LRU cache is https-only and skips them.
   */
  private fun artworkUri(ctx: Context, bytes: ByteArray?): String? {
    if (bytes == null || bytes.isEmpty()) return null
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
    val name = digest.joinToString("") { "%02x".format(it) }
    val dir = java.io.File(ctx.filesDir, "art")
    val out = java.io.File(dir, "$name.${artworkExt(bytes)}")
    if (!out.isFile) {
      try {
        dir.mkdirs()
        out.writeBytes(bytes)
      } catch (e: Exception) {
        // Art is best-effort inside the batch — a store failure must
        // not turn into a per-doc null.
        Log.w(TAG, "art store write failed: ${e.message}")
        return null
      }
    }
    // Uri.fromFile mints the `file:///`-form the domain's artwork-url
    // validator admits — java.io.File.toURI would emit single-slash
    // `file:/`, which fails the recording commit's persisted check.
    return Uri.fromFile(out).toString()
  }

  /** Image format sniffed from magic bytes — the retriever's
   * embeddedPicture carries no mime. */
  private fun artworkExt(bytes: ByteArray): String = when {
    bytes.size >= 4 &&
      bytes[0] == 0x89.toByte() && bytes[1] == 0x50.toByte() &&
      bytes[2] == 0x4e.toByte() && bytes[3] == 0x47.toByte() -> "png"
    bytes.size >= 2 &&
      bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte() -> "jpg"
    bytes.size >= 12 &&
      bytes[0] == 'R'.code.toByte() && bytes[1] == 'I'.code.toByte() &&
      bytes[2] == 'F'.code.toByte() && bytes[3] == 'F'.code.toByte() &&
      bytes[8] == 'W'.code.toByte() && bytes[9] == 'E'.code.toByte() &&
      bytes[10] == 'B'.code.toByte() && bytes[11] == 'P'.code.toByte() -> "webp"
    bytes.size >= 6 &&
      bytes[0] == 'G'.code.toByte() && bytes[1] == 'I'.code.toByte() &&
      bytes[2] == 'F'.code.toByte() && bytes[3] == '8'.code.toByte() -> "gif"
    else -> "img"
  }

  /** The playable document URI — resolves through SAF URI math. */
  fun documentUri(treeUri: Uri, docId: String): String =
    docUri(treeUri, docId).toString()
}
