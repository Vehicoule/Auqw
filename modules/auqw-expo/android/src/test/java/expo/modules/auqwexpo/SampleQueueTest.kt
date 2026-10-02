package expo.modules.auqwexpo

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.util.ParsableByteArray
import androidx.media3.extractor.DiscardingTrackOutput
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The demux side of the streamed decode lane: exactly one audio track
 * may ever feed the shared sample queue — the codec is configured for
 * the first audio track's format, so a second track's access units
 * arriving interleaved on the same queue would be undecodable
 * bitstream (CodecException or corrupt PCM). The selection keys on the
 * extractor's track id: a re-parse after a seek that re-emits the same
 * id keeps feeding the same track.
 */
class SampleQueueTest {

  private fun feed(
    output: androidx.media3.extractor.TrackOutput,
    timeUs: Long,
    data: ByteArray,
  ) {
    output.sampleData(ParsableByteArray(data), data.size, 0)
    output.sampleMetadata(timeUs, C.BUFFER_FLAG_KEY_FRAME, data.size, 0, null)
  }

  @Test
  fun `only the first audio track gets a real output`() {
    val pump = SampleQueue()
    assertTrue(pump.track(0, C.TRACK_TYPE_VIDEO) is DiscardingTrackOutput)
    val first = pump.track(1, C.TRACK_TYPE_AUDIO)
    assertFalse(first is DiscardingTrackOutput)
    assertTrue(pump.track(2, C.TRACK_TYPE_AUDIO) is DiscardingTrackOutput)
    assertTrue(pump.track(3, C.TRACK_TYPE_AUDIO) is DiscardingTrackOutput)
    // A re-parse re-emitting the selected id keeps the same lane —
    // the extractor may call track() again after a mid-parse seek.
    assertFalse(pump.track(1, C.TRACK_TYPE_AUDIO) is DiscardingTrackOutput)
  }

  @Test
  fun `only the selected track's access units reach the queue`() {
    val pump = SampleQueue()
    val first = pump.track(1, C.TRACK_TYPE_AUDIO)
    val second = pump.track(2, C.TRACK_TYPE_AUDIO)

    first.format(Format.Builder().setSampleMimeType("audio/flac").build())
    second.format(Format.Builder().setSampleMimeType("audio/aac").build())
    assertEquals("audio/flac", pump.audioFormat?.sampleMimeType)

    feed(first, 0L, byteArrayOf(1, 2, 3))
    feed(second, 10_000L, byteArrayOf(9, 9, 9, 9))
    feed(first, 20_000L, byteArrayOf(4, 5))

    assertEquals(2, pump.samples.size)
    assertEquals(0L, pump.samples[0].timeUs)
    assertEquals(3, pump.samples[0].data.size)
    assertEquals(20_000L, pump.samples[1].timeUs)
    assertEquals(2, pump.samples[1].data.size)
  }
}
