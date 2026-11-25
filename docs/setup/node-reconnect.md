# Recover a paired Mac node

Use this when a Mac still appears in the main's Nodes roster and its heartbeat
is healthy, but desktop views report that main workspace authorization is
missing. This is a node authorization repair; it does not re-pair the phone or
replace the main owner token.

On the affected Mac, run:

```sh
openagi reconnect
```

The command creates a five-minute, single-use request bound to that Mac's
existing node credential and the exact main identity. An already enrolled owner
phone must approve the request through the mobile reconnect API. After approval,
the Mac receives a newly rotated, node-scoped owner-proxy credential, stores it
in its existing `node.json`, acknowledges delivery, and asks the local daemon to
restart through its normal supervised path. The operational node credential,
remote address, phone pairing, and saved work remain in place.

The mobile API is:

- `GET /nodes/reconnect/requests` to list pending requests;
- `POST /nodes/reconnect/requests/<request-id>/approve` or `/deny` to decide;
- the approval response contains no credential;
- only the target Mac's operational credential can read
  `GET /nodes/reconnect/requests/<request-id>` and receive the transient grant;
- the target acknowledges with `POST /nodes/reconnect/requests/<request-id>/ack`.

All of these routes are authenticated. The request expires, approval cannot be
replayed, node revocation removes both credential hashes, and host reachability
or an operating-system password never authorizes a node. The main owner token
never leaves the owner device.

If the Mac has no confirmed node pairing, or the main is unreachable, no
reconnect request is created. Re-pair once through the normal secure main-owner
flow, then retry. The current release ships the server primitive and CLI
recovery path; a native phone approval screen is a follow-up integration for the
iOS and Android clients.
