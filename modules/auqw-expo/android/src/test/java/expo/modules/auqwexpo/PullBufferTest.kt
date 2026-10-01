package expo.modules.auqwexpo

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The stripe sweep's shared sparse store, under its named invariants:
 * out-of-order stripe arrivals only extend the frontier through the
 * gap, an abandoned hole ends readers at the hole (never parks), a
 * confirmed EOF ends readers at it, and a parked reader unwinds when
 * its scope dies (the decode lane's cancellation path).
 */
class PullBufferTest {

  private fun bytes(v: Int, n: Int) = ByteArray(n) { v.toByte() }

  private fun read(buf: PullBuffer, at: Long, len: Int): Pair<Int, ByteArray> {
    val out = ByteArray(len)
    val n = buf.readAt(at, out, 0, len) { true }
    return n to out
  }

  @Test
  fun `frontier waits for the gap`() {
    val buf = PullBuffer(1024)
    buf.put(512, bytes(2, 512))
    assertEquals(0L, buf.contiguousEnd)
    buf.put(0, bytes(1, 256))
    assertEquals(256L, buf.contiguousEnd)
    buf.put(256, bytes(3, 256))
    assertEquals(1024L, buf.contiguousEnd)
  }

  @Test
  fun `readAt serves contiguous bytes across a chunk boundary`() {
    val buf = PullBuffer(1024)
    buf.put(0, bytes(1, 512))
    buf.put(512, bytes(2, 512))
    val (n, out) = read(buf, 500, 32)
    assertEquals(32, n)
    assertEquals(1, out[0].toInt())
    assertEquals(2, out[12].toInt())
    assertEquals(2, out[31].toInt())
  }

  @Test
  fun `readAt returns -1 at an abandoned hole`() {
    val buf = PullBuffer(1024)
    buf.put(0, bytes(1, 256))
    buf.abandonFrom(256)
    val (n, _) = read(buf, 256, 8)
    assertEquals(-1, n)
  }

  @Test
  fun `readAt returns -1 at a confirmed eof`() {
    val buf = PullBuffer(1024)
    buf.observeEof(512)
    val (n, _) = read(buf, 512, 8)
    assertEquals(-1, n)
  }

  @Test
  fun `readAt returns -1 past the observed total`() {
    val buf = PullBuffer(1024)
    buf.observeTotal(512)
    val (n, _) = read(buf, 512, 8)
    assertEquals(-1, n)
  }

  @Test
  fun `readAt returns -1 once pull is done at the frontier`() {
    val buf = PullBuffer(1024)
    buf.markPullDone()
    val (n, _) = read(buf, 0, 8)
    assertEquals(-1, n)
  }

  @Test
  fun `parked reader wakes when the hole commits`() {
    val buf = PullBuffer(1024)
    val arrived = CountDownLatch(1)
    val reader = thread {
      val (n, out) = read(buf, 0, 4)
      if (n == 4 && out[0].toInt() == 7) arrived.countDown()
    }
    Thread.sleep(150)
    buf.put(0, bytes(7, 64))
    assertTrue("reader stayed parked past its hole's commit", arrived.await(2, TimeUnit.SECONDS))
    reader.join(2000)
  }

  @Test
  fun `parked reader unwinds when alive flips dead`() {
    val buf = PullBuffer(1024)
    var alive = true
    val done = CountDownLatch(1)
    val reader = thread {
      if (buf.readAt(0, ByteArray(4), 0, 4) { alive } == -1) done.countDown()
    }
    Thread.sleep(150)
    alive = false
    assertTrue("cancelled reader stayed parked", done.await(2, TimeUnit.SECONDS))
    reader.join(2000)
  }

  @Test
  fun `pullComplete is true at frontier end and false after abandon`() {
    val buf = PullBuffer(512)
    buf.put(0, bytes(1, 512))
    assertTrue(buf.pullComplete())

    val dead = PullBuffer(1024)
    dead.put(0, bytes(1, 256))
    dead.observeEof(512)
    dead.abandonFrom(256)
    assertFalse("a stripe's dead hole still completed the pull", dead.pullComplete())
  }
}
