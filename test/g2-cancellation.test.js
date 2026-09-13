import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIResponsesProvider, AnthropicProvider } from "../src/model-provider.js";

for (const [Provider, method] of [[OpenAIResponsesProvider, "postResponsesStream"], [AnthropicProvider, "postMessagesStream"]]) {
  test(`${Provider.name} propagates caller cancellation to the provider request`, async () => {
    const controller = new AbortController();
    let seenSignal;
    const provider = new Provider({ apiKey: "test", fetchImpl: (_url, init) => {
      seenSignal = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    } });
    const pending = provider[method]({}, { signal: controller.signal }, () => {});
    controller.abort();
    await assert.rejects(() => pending);
    assert.equal(seenSignal.aborted, true);
  });
}
