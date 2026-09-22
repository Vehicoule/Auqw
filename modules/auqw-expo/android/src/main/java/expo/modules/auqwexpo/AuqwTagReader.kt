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
    val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION
    try {
      ctx.contentResolver.takePersistableUriPermission(treeUri, flags)
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
    return Pair(treeUri.toString(), label)
  }

  /**
   * Depth-first walk of the tree. Yields entries for files whose mime
   * is audio/* (or unknown-but-audio-looking); directories recurse.
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
      val cursor = try {
        ctx.contentResolver.query(
          children,
          arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED
          ),
          null, null, null
        )
      } catch (e: Exception) {
        throw e
      } ?: continue
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

  /**
   * sha256(head 4KiB || tail 4KiB || sizeLE) per doc; null per entry
   * on open/read failure so the batch survives one bad file.
   */
  fun fingerprint(
    ctx: Context,
    treeUri: Uri,
    docIds: List<String>
  ): List<Map<String, Any?>?> {
    return docIds.map { docId ->
      try {
        fingerprintOne(ctx, treeUri, docId)
      } catch (e: Exception) {
        Log.w(TAG, "fingerprint failed for $docId: ${e.message}")
        null
      }
    }
  }

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
        val headBuf = java.nio.ByteBuffer.wrap(head)
        while (headBuf.hasRemaining()) {
          if (ch.read(headBuf) < 0) break
        }
        digest.update(head, 0, headBuf.position())
        if (tail.isNotEmpty()) {
          val tailBuf = java.nio.ByteBuffer.wrap(tail)
          ch.position(size - tail.size)
          while (tailBuf.hasRemaining()) {
            if (ch.read(tailBuf) < 0) break
          }
          digest.update(tail, 0, tailBuf.position())
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

  /** MediaMetadataRetriever tags per doc; null per-entry on failure. */
  fun readTags(
    ctx: Context,
    treeUri: Uri,
    docIds: List<String>
  ): List<Map<String, Any?>?> {
    return docIds.map { docId ->
      try {
        tagsOne(ctx, treeUri, docId)
      } catch (e: Exception) {
        Log.w(TAG, "readTags failed for $docId: ${e.message}")
        null
      }
    }
  }

  private fun tagsOne(
    ctx: Context,
    treeUri: Uri,
    docId: String
  ): Map<String, Any?> {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(ctx, docUri(treeUri, docId))
      val duration = retriever
        .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
        ?.toLongOrNull()
      return mapOf(
        "docId" to docId,
        "title" to retriever.extractMetadata(
          MediaMetadataRetriever.METADATA_KEY_TITLE
        ),
        "artist" to retriever.extractMetadata(
          MediaMetadataRetriever.METADATA_KEY_ARTIST
        ),
        "album" to retriever.extractMetadata(
          MediaMetadataRetriever.METADATA_KEY_ALBUM
        ),
        "durationMs" to (duration?.toDouble() ?: 0.0).let {
          if (it > 0) it else null
        },
        "genre" to retriever.extractMetadata(
          MediaMetadataRetriever.METADATA_KEY_GENRE
        )
      )
    } finally {
      retriever.release()
    }
  }

  /** The playable document URI — resolves through SAF URI math. */
  fun documentUri(treeUri: Uri, docId: String): String =
    docUri(treeUri, docId).toString()
}
