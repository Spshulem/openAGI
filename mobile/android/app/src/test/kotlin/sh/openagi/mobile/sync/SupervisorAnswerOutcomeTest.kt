package sh.openagi.mobile.sync

import org.junit.Assert.assertEquals
import org.junit.Test
import sh.openagi.mobile.transport.DaemonException
import java.io.IOException

class SupervisorAnswerOutcomeTest {
    @Test
    fun aSuccessfulSendIsDone() {
        assertEquals(AnswerOutcome.Done, answerOutcome(null, attempt = 0))
        assertEquals(AnswerOutcome.Done, answerOutcome(null, attempt = 2))
    }

    // 404 and 409 both mean the question is no longer open: answered on the
    // Mac, on another phone, or closed by the supervisor itself. Nothing left
    // to send, so the notification just goes away.
    @Test
    fun anAlreadyClosedQuestionIsDone() {
        assertEquals(AnswerOutcome.Done, answerOutcome(DaemonException.NotFound(), attempt = 0))
        assertEquals(AnswerOutcome.Done, answerOutcome(DaemonException.Conflict(), attempt = 0))
    }

    // A refused credential will not start working on a retry.
    @Test
    fun aRefusedCredentialFailsAtOnce() {
        assertEquals(AnswerOutcome.Failed, answerOutcome(DaemonException.Unauthorized(), attempt = 0))
    }

    @Test
    fun transientFailuresRetryUntilTheThirdAttempt() {
        val offline = DaemonException.Transport(IOException("no route"))
        assertEquals(AnswerOutcome.Retry, answerOutcome(offline, attempt = 0))
        assertEquals(AnswerOutcome.Retry, answerOutcome(offline, attempt = 1))
        assertEquals(AnswerOutcome.Failed, answerOutcome(offline, attempt = 2))
        assertEquals(AnswerOutcome.Failed, answerOutcome(offline, attempt = 7))
    }

    @Test
    fun anyOtherErrorIsTreatedAsTransient() {
        assertEquals(AnswerOutcome.Retry, answerOutcome(DaemonException.Server(502), attempt = 0))
        assertEquals(AnswerOutcome.Retry, answerOutcome(DaemonException.Unavailable(), attempt = 1))
        assertEquals(AnswerOutcome.Retry, answerOutcome(DaemonException.Malformed(), attempt = 0))
        assertEquals(AnswerOutcome.Retry, answerOutcome(IllegalStateException("boom"), attempt = 0))
        assertEquals(AnswerOutcome.Failed, answerOutcome(DaemonException.Server(500), attempt = 2))
    }

    @Test
    fun aSuccessfulPostWhoseDeliveryWentNowhereIsUndelivered() {
        assertEquals(AnswerOutcome.Done, answerOutcome(null, attempt = 0, deliveryStatus = "sent"))
        assertEquals(AnswerOutcome.Done, answerOutcome(null, attempt = 0, deliveryStatus = null))
        assertEquals(AnswerOutcome.Undelivered, answerOutcome(null, attempt = 0, deliveryStatus = "blocked"))
        assertEquals(AnswerOutcome.Undelivered, answerOutcome(null, attempt = 0, deliveryStatus = "failed"))
    }
}
