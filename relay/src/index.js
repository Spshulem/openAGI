// Cloudflare Worker entrypoint for the OpenAGI push relay.
// Logic lives in relay.js so tests can reach its hooks without adding
// non-handler exports to the Worker module.
import { handle } from "./relay.js";

export default {
  fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
};
