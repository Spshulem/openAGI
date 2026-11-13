package sh.openagi.mobile.fallback

import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.junit.Assert.*
import org.junit.Test

class LocalChatRunnerTest {
    private open class Client : LocalGenerationClient {
        var closed = false
        override suspend fun status() = FeatureStatus.AVAILABLE
        override fun download(): Flow<DownloadStatus> = emptyFlow()
        override suspend fun generate(prompt: String) = "Hello"
        override fun close() { closed = true }
    }

    @Test fun blockingClientSetupLeavesCallerResponsive() = runBlocking {
        val caller = Thread.currentThread()
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val client = object : Client() {
            override suspend fun status(): Int {
                assertNotSame(caller, Thread.currentThread())
                return super.status()
            }
            override fun close() {
                assertNotSame(caller, Thread.currentThread())
                super.close()
            }
        }
        val runner = LocalChatRunner(createClient = {
            assertNotSame(caller, Thread.currentThread())
            started.countDown()
            check(release.await(5, TimeUnit.SECONDS)) { "Caller couldn't respond during client setup" }
            client
        })
        val preparation = async { runner.status() }
        try {
            assertTrue(withContext(Dispatchers.IO) { started.await(5, TimeUnit.SECONDS) })
            var responded = false
            launch { responded = true }.join()
            assertTrue("UI caller must remain free while AICore is blocked", responded)
        } finally { release.countDown() }
        assertEquals(FeatureStatus.AVAILABLE, preparation.await())
        assertTrue(client.closed)
    }

    @Test fun downloadUsesWorkerAndDeliversRealProgressOnCaller() = runBlocking {
        val caller = Thread.currentThread()
        val client = object : Client() {
            override fun download(): Flow<DownloadStatus> {
                assertNotSame(caller, Thread.currentThread())
                return flow {
                    assertNotSame(caller, Thread.currentThread())
                    emit(DownloadStatus.DownloadStarted(1_000))
                    emit(DownloadStatus.DownloadProgress(250))
                    emit(DownloadStatus.DownloadCompleted)
                }
            }
            override fun close() {
                assertNotSame(caller, Thread.currentThread())
                super.close()
            }
        }
        val progress = LocalChatRunner(createClient = {
            assertNotSame(caller, Thread.currentThread())
            client
        }).download().onEach { assertSame(caller, Thread.currentThread()) }.toList()
        assertEquals(0f, progress[0].fraction!!, 0f)
        assertEquals(250L, progress[1].downloadedBytes)
        assertEquals(1_000L, progress[1].totalBytes)
        assertEquals(0.25f, progress[1].fraction!!, 0f)
        assertTrue(progress.last().gettingReady)
        assertNull(progress.last().fraction)
        assertTrue(client.closed)
    }

    @Test fun cancellationClosesDownloadingClient() = runBlocking {
        val client = object : Client() {
            override fun download(): Flow<DownloadStatus> = flow {
                emit(DownloadStatus.DownloadStarted(1_000))
                awaitCancellation()
            }
        }
        LocalChatRunner(createClient = { client }).download().take(1).toList()
        assertTrue(client.closed)
    }

    @Test fun failedDownloadClosesClientAndPropagatesFailure() = runBlocking {
        val client = object : Client() {
            override fun download(): Flow<DownloadStatus> = flow { throw FallbackException("Download failed") }
        }
        try {
            LocalChatRunner(createClient = { client }).download().toList()
            fail("Download failures must reach the screen")
        } catch (e: FallbackException) { assertEquals("Download failed", e.message) }
        assertTrue(client.closed)
    }

    @Test fun inferenceAndCleanupUseWorkerToo() = runBlocking {
        val caller = Thread.currentThread()
        val client = object : Client() {
            override suspend fun generate(prompt: String): String {
                assertNotSame(caller, Thread.currentThread())
                assertTrue(prompt.contains("user: Hi"))
                return "Hello"
            }
            override fun close() {
                assertNotSame(caller, Thread.currentThread())
                super.close()
            }
        }
        val result = LocalChatRunner(createClient = { client }).reply(listOf(FallbackLine("user", "Hi")))
        assertEquals("Hello", result)
        assertTrue(client.closed)
    }

    @Test fun unknownSizeNeverInventsPercentageAndCompletionIsNotReadiness() {
        assertNull(LocalModelProgress(100).fraction)
        assertNull(LocalModelProgress(100, 0).fraction)
        assertEquals(1f, LocalModelProgress(200, 100).fraction!!, 0f)
        assertNull(LocalModelProgress(100, 100, gettingReady = true).fraction)
        assertTrue(LocalModelProgress(gettingReady = true).description.contains("getting Gemini Nano ready"))
    }

    @Test fun missingAndDownloadingModelsGiveDifferentRecoveryActions() = runBlocking {
        for ((status, expected) in listOf(
            FeatureStatus.DOWNLOADABLE to "device-model-download-required",
            FeatureStatus.DOWNLOADING to "device-model-downloading",
            FeatureStatus.UNAVAILABLE to "device-model-unsupported",
        )) {
            val client = object : Client() {
                override suspend fun status() = status
                override suspend fun generate(prompt: String): String = error("Must not infer before the model is ready")
            }
            try {
                LocalChatRunner(createClient = { client }).generate("Hello")
                fail("Model readiness must be checked before inference")
            } catch (e: LocalModelFailure) { assertEquals(expected, e.code) }
            assertTrue(client.closed)
        }
    }

    @Test fun cancellingInferenceIsNotReportedAsModelUnavailable() = runBlocking {
        val client = object : Client() {
            override suspend fun generate(prompt: String): String = throw CancellationException("Stopped")
        }
        try {
            LocalChatRunner(createClient = { client }).generate("Hello")
            fail("Cancellation must propagate")
        } catch (e: CancellationException) { assertEquals("Stopped", e.message) }
        assertTrue(client.closed)
    }
}
