# Understanding Computer Use readiness

Enabling Computer Use does not grant macOS permissions or prove input works.

- **Control ready:** the selected node advertises the baseline input operations
  and capture readiness. This is not proof that a delegated task completed.
- **Permissions required:** a connected node reports unmet prerequisites. Check
  Screen Recording, Accessibility, screen lock, and Secure Input on that node.
  OpenAGI does not bypass these controls or automatically grant access.
- **Node selection required:** more than one computer is advertised and there
  is no unambiguous execution target. Select the intended node when requesting
  the computer-use session; do not assume an arbitrary computer was chosen.
- **Node unreachable:** an explicitly configured endpoint cannot be used.
  Verify that connection and scoped authentication rather than adding a second
  responder or granting broad credentials.
- **Observation only:** no usable current computer-node advertisement exists.
  Recent OCR is historical text, not a live screenshot or input capability.

Readiness diagnostics use current local health and fresh authenticated node
advertisements. Cached rows on the Nodes page are not evidence of reachability.
An unready advertisement is visible for diagnosis only: the execution resolver
still excludes it, and no input operation is dispatched by a readiness check.
