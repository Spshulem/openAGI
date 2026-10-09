# Cron recovery after a start-marker write failure

A file-backed cron start marker is written before dispatch. Previously, a failed
write escaped the execution cleanup boundary, leaving the in-memory run and
same-job overlap guard active indefinitely. The job never reached its handler
or timeout, so later scheduled attempts skipped it even after storage recovered.

Start-marker persistence now runs inside the execution try/finally boundary.
A failed write records a terminal failed run, clears the execution guard and
marker, and skips handler dispatch. Scheduled attempts advance normally; manual
attempts can be retried. Other due jobs continue when their marker writes succeed.
The durable marker still precedes every handler; persistence is never bypassed.

Regression coverage injects a marker-save failure for both scheduled and manual
runs, verifies terminal timestamps and guard cleanup, then verifies successful
execution after storage recovery. Existing timeout, overlap, manual-run, disabled
job sorting, and boot-marker tests cover the surrounding scheduler contract.

This repairs scheduler recovery, not insufficient storage. Persistent write
failures still surface as errors and require storage recovery. Already stranded
in-memory guards in an older installed daemon require a separately authorized
restart; source verification does not establish installation or live recovery.

No Swift code or native interface behavior changes in this fix.
