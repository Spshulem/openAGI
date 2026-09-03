# Even G2 client overlay

This directory is the client half of openAGI's Even Realities G2 integration.
Its paths are relative to the existing `/Users/shooby/Dev/g2` Even Hub project:

- `src/openagi/`, `src/app/openagi-g2-app.ts`, and the two `src/ui/openagi-*`
  files add the scoped node client, state, device UI, heartbeat, and voice conversation flow.
- `src/main.ts` selects BuildBetter or OpenAGI with `VITE_G2_MODE`, preserving
  the existing BuildBetter behavior by default.
- `scripts/package-openagi.mjs` generates an exact-origin Even Hub manifest and
  packages the OpenAGI variant without embedding credentials.
- `package.json`, `.env.example`, and `README.md` contain the corresponding
  commands and setup documentation.

The source is kept as an overlay because the G2 project is a separate local
workspace. Apply the files at the same relative paths, then run `pnpm check`
there. Package only after choosing the exact public HTTPS origin:

```bash
pnpm package:openagi -- https://your-openagi-host.example.com
```
