# Connect another computer

Choose one main host to hold the agent's state, then install OpenAGI on the
other computer using the [install guide](../INSTALL.md). Each node gets a scoped
credential and advertises its capabilities. It is not a copy of every other
device's permissions.

1. Make the main reachable through an authenticated HTTPS reverse proxy or
   encrypted private tunnel. Loopback is the default for a fresh local daemon;
   another device cannot reach that machine's `127.0.0.1`. A non-loopback bind
   requires authentication. Keep your dashboard token private.
2. On the new computer, provide the initial main credential through
   `OPENAGI_REMOTE_TOKEN` in your private local environment. Do not put it in
   chat, a URL, a command-line flag, a public repository, or a screenshot.
3. Run the pairing command from the installed source/runtime folder:

   ```sh
   node bin/openagi.js pair https://agent.example.com
   ```

   Replace the address with your own main. Portable bundles can use their
   bundled `node/node` (Linux) or `node\node.exe` (Windows). An installed CLI can
   use `openagi pair <main-url>`. Restart the node if the command asks you to.
   Remove the temporary bootstrap credential from the shell when finished.
4. Run `node bin/openagi.js status` and `node bin/openagi.js doctor`, then open
   **More → Nodes** on the main. Confirm a fresh heartbeat from the expected
   computer. A saved pairing alone does not prove enrollment succeeded.
5. Try the particular capability you need. CLI chat and an online heartbeat
   do not prove native capture, computer input, a local coding provider, or
   another device's account access. Keep operating-system permissions scoped
   to the host that needs them.

`node bin/openagi.js unpair` revokes the remote credential and removes the local
pairing after successful revocation. If the main is unreachable, retry when it
returns; forgetting local state alone cannot prove the remote token was revoked.

Phones use a different, single-use-code flow: see [mobile pairing](../../mobile/README.md).
Glasses use [Connect glasses](even-g2.md). Never substitute an owner credential
for a device's scoped credential in requests after enrollment.
