---
name: customer-report-verifier
description: "End-to-end verifier for customer Lifecycles/Rubric reports (including AppFolio via buildbetter-staging MCP) before owner review."
createdBy: owner
---

# Customer Report & Lifecycles Link Verifier

Use this skill whenever preparing, updating, or verifying a customer-facing BuildBetter Lifecycles / Rubric report (such as **AppFolio**, **Brex**, **StayVista**, or **Intruder**).

## Critical MCP Environment Rule
- **AppFolio Lifecycles & MCP Management:** Do **NOT** require or block on the production BuildBetter MCP connector for AppFolio. The **staging MCP (`buildbetter-staging`)** is the authoritative MCP managing AppFolio's workspace and Lifecycles reports. Always create, update, and verify AppFolio reports via `buildbetter-staging` MCP (`list_mcp_tools` / `run_mcp_tool` with `server: "buildbetter-staging"`, or instruct the Paseo coding session to use `buildbetter-staging`).

## Verification Checklist Before Pinging the Owner
1. **Search Prior Feedback First:** Call `search_sessions` for the customer name (e.g. `"AppFolio"`, `"Brex"`, `"StayVista"`) and list every complaint or requirement Spencer previously raised so zero regressions slip through.
2. **Verify Live Signed-Out / Shareable Link:**
   - Confirm the report URL loads cleanly without permission errors.
   - Check every rubric/lifecycle section: **zero** sections may say `"not scored"`, `"not tested"`, `"no result"`, or contain empty placeholders unless explicitly documented and justified.
3. **Iterate Until Complete:**
   - If any section is incomplete or fails verification, send the exact defect list back to the owning Paseo session (`fleet_send_message`) and re-verify — do **not** mark the goal done or hand an unverified link to Spencer.
4. **Hard Red Line:**
   - **Never** email, Slack, or send the report externally to the customer or teammate (e.g. Chris or James) yourself. Hand the verified link + checklist summary to Spencer (or save a draft via `save_draft`) for his final sign-off.
