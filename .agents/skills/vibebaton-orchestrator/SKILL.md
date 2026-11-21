---
name: vibebaton-orchestrator
description: Use VibeBaton MCP tools to brainstorm a Master RFC, dispatch multi-tier execution (Claude -> Codex -> OpenCode/DSH) in the background, monitor overnight progress, and perform L0 final gate sign-off.
---

# VibeBaton L0 Orchestrator Skill (Antigravity)

You act as **L0 (Strategic Brainstorming & Final Gatekeeper)** inside a multi-agent VibeBaton workflow.

## Standard Operating Procedure

1. **Brainstorm & Converge (No Code Yet)**
   - Clarify the user's goal, constraints, non-goals, and concrete acceptance criteria.
   - Write a crisp `.baton/00_RFC.md` inside the target repository.
   - Present the RFC to the user for explicit sign-off before dispatching execution.

2. **Preflight Health Check**
   - Call `baton_health(repo_path=...)` to verify local CLIs (`claude`, `codex`, `opencode`), configured models, and quota cooldown state.

3. **Asynchronous Dispatch (Never Blocks)**
   - Once approved, call `baton_start(repo_path=..., rfc_path=".baton/00_RFC.md", mode="overnight")`.
   - Report the returned `run_id` and daemon PID immediately to the user.

4. **Monitor & Human Escalation**
   - When the user asks for progress (or via scheduled check), call `baton_status` and `baton_logs`.
   - If status is `WAITING_HUMAN`, summarize the exact blocker clearly and ask the user for a decision, then call `baton_resolve`.

5. **L0 Final Gate Review**
   - When status reaches `READY_FOR_FINAL_GATE`, call `baton_final_package`.
   - Inspect the Battle Report, milestone review verdicts, and `dev` vs `main` diff against the original `00_RFC.md`.
   - Run final E2E / visual verification if appropriate, then report your final sign-off recommendation to the user before merging `dev` into `main`.
