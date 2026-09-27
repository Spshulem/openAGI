#!/usr/bin/env node
// Read-only check of what computer-use delivery would see in an app. Parses
// an Open Computer Use accessibility snapshot from stdin; it never clicks,
// types, or opens anything:
//
//   open-computer-use snapshot com.conductor.app | node scripts/fleet-ui-probe.mjs [--expect <name>]...
//
// Prints the window title, selected elements, headings, the composer the
// fleet would type into, the Send button, and the Stop / permission-prompt
// guards. Each --expect is an identity token (workspace name, tab or thread
// title) checked the way a delivery checks it.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  findComposer, findSendButton, hasPermissionPrompt, hasStopButton, identityToken, parseAppState, verifyIdentity
} from "../src/fleet/ui-delivery.js";

export function probeText(text, expect = []) {
  const state = parseAppState({ content: [{ type: "text", text: String(text ?? "") }] });
  const label = (element) => `${element.id} ${element.role}${element.label ? ` "${element.label.slice(0, 80)}"` : ""}`;
  const composer = findComposer(state);
  const send = findSendButton(state);
  const tokens = expect.map(identityToken).filter(Boolean);
  return {
    app: state.bundleId,
    window: state.windowTitle,
    elements: state.elements.length,
    focused: state.focusedId,
    selected: state.elements.filter((element) => element.selected).map(label).slice(0, 20),
    headings: state.elements.filter((element) => element.role === "heading").map(label).slice(0, 20),
    composer: composer.composer ? { element: label(composer.composer), empty: !composer.composer.value.trim() } : { error: composer.reason },
    send: send ? label(send) : null,
    stopVisible: hasStopButton(state),
    permissionPrompt: hasPermissionPrompt(state),
    identity: tokens.length ? { tokens, ...verifyIdentity(state, { tokens }) } : null
  };
}

function main(argv) {
  const expect = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--expect" && argv[i + 1]) expect.push(argv[(i += 1)]);
    else if (argv[i] === "-h" || argv[i] === "--help") {
      process.stdout.write("open-computer-use snapshot <bundle id> | node scripts/fleet-ui-probe.mjs [--expect <name>]...\n");
      return 0;
    }
  }
  if (process.stdin.isTTY) {
    process.stderr.write("Pipe an Open Computer Use snapshot into stdin (see --help).\n");
    return 2;
  }
  const text = fs.readFileSync(0, "utf8");
  process.stdout.write(`${JSON.stringify(probeText(text, expect), null, 2)}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
