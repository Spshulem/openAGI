package sh.openagi.mobile.fallback

import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException

// Only curated messages cross the model bridge into durable chat history.
// SDK exception text can include request content and is never shown there.
internal class LocalModelFailure(val code: String, message: String, cause: Throwable? = null) : Exception(message, cause)

internal fun modelNotReady(status: Int): LocalModelFailure = when (status) {
    FeatureStatus.DOWNLOADABLE -> LocalModelFailure("device-model-download-required", "Download Gemini Nano in Chat options before using the phone agent.")
    FeatureStatus.DOWNLOADING -> LocalModelFailure("device-model-downloading", "Gemini Nano is still downloading. Open Chat options to see its progress.")
    else -> LocalModelFailure("device-model-unsupported", "Gemini Nano isn't available on this phone. Check for Android and AICore updates in Chat options, or choose another model.")
}

internal fun localModelFailure(error: Exception): LocalModelFailure {
    if (error is LocalModelFailure) return error
    return when ((error as? GenAiException)?.errorCode) {
        GenAiException.ErrorCode.REQUEST_TOO_LARGE -> LocalModelFailure("device-model-input-limit", "This conversation is too long for Gemini Nano. Start a new chat or send a shorter message.", error)
        GenAiException.ErrorCode.BACKGROUND_USE_BLOCKED -> LocalModelFailure("device-model-foreground-required", "Keep OpenAGI open and your phone unlocked while Gemini Nano replies.", error)
        GenAiException.ErrorCode.BUSY -> LocalModelFailure("device-model-busy", "Gemini Nano is busy. Wait a moment and try again with OpenAGI open.", error)
        GenAiException.ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED -> LocalModelFailure("device-model-quota", "Android has temporarily limited Gemini Nano's battery usage. Try again later or choose another model.", error)
        GenAiException.ErrorCode.AICORE_INCOMPATIBLE, GenAiException.ErrorCode.NEEDS_SYSTEM_UPDATE -> LocalModelFailure("device-model-system-update", "Gemini Nano needs an Android or Google AICore update. Check for updates, then reopen OpenAGI.", error)
        GenAiException.ErrorCode.NOT_SUPPORTED -> modelNotReady(FeatureStatus.UNAVAILABLE)
        GenAiException.ErrorCode.NOT_ENOUGH_DISK_SPACE -> LocalModelFailure("device-model-storage", "Gemini Nano needs more free storage on this phone. Free up space, then check the model in Chat options.", error)
        GenAiException.ErrorCode.REQUEST_PROCESSING_ERROR, GenAiException.ErrorCode.RESPONSE_GENERATION_ERROR, GenAiException.ErrorCode.RESPONSE_PROCESSING_ERROR -> LocalModelFailure("device-model-rejected", "Gemini Nano couldn't answer that message. Try rephrasing it.", error)
        else -> LocalModelFailure("device-model-unavailable", "Gemini Nano couldn't start. Check its availability in Chat options, then try again with OpenAGI open.", error)
    }
}
