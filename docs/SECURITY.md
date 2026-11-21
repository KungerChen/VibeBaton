# VibeBaton Security Model & Trust Boundaries

> **TL;DR**: VibeBaton's **Path Whitelist Guard** is a post-hoc Git worktree audit & revert mechanism — **NOT an OS-level kernel sandbox**. Running unattended overnight pipelines on your host machine is intended **only for repositories you trust**.

---

## 1. Threat Model & Trust Boundaries

### What Path Whitelist Guard Protects Against
- Accidental or out-of-scope file edits inside the target repository by worker agents (`routine` / `critical` tasks).
- Leftover dirty files or stray tool caches leaking across sibling parallel worktrees or onto `main`.

### What Path Whitelist Guard Does NOT Prevent on the Host
To avoid interactive `[y/N]` stalls during unattended overnight runs, local CLI providers may be invoked with non-interactive flags configured in `baton.toml` / `baton.example.toml` (for example, `claude --dangerously-skip-permissions`, `codex exec -s workspace-write -c approval_policy="never"`, or `dsh --permission-mode workspace-write --approval-policy never`).

Because `claude` and shell commands execute under your local OS user account:
- **Untrusted repositories / Prompt Injection**: Malicious instructions embedded in third-party READMEs, issues, code comments, or dependency scripts could instruct an agent to read sensitive local files (such as `~/.ssh`, cloud credentials, or `.env` files outside the worktree), delete files outside the repo, or make outbound network requests.
- **Post-hoc vs. Pre-execution**: Git whitelist checking runs *after* a CLI turn exits, so side effects outside the git worktree or over the network cannot be rolled back by Git.

### Safe Usage Rules
1. **Host execution**: Only run unattended pipelines directly on the host against **your own trusted repositories** and inspected dependencies.
2. **Untrusted repositories**: Always run VibeBaton inside an isolated VM, Windows Sandbox, or container (a turnkey **Docker / DevContainer sandbox template** is scheduled for Stage 4 `v1.0`).
3. **Human-in-the-Loop Anchors**: Keep `require_human_approval_at = ["rfc_signoff", "plan_amendment", "final_merge"]` enabled so AI milestones never auto-merge directly into `main` without L0 / human review.

---

## 2. Provider Terms & Polite Rate-Limit Scheduling

VibeBaton is explicitly designed to **respect provider rate limits and terms of service**, never to bypass them:
- **Conservative Concurrency**: Subscription CLI providers default to `max_concurrency = 1` in `baton.example.toml`.
- **Active Cooldown Backoff**: On detecting `429` / usage-limit / quota responses, VibeBaton pauses only the throttled provider using exponential backoff (`cooldown_backoff_sec`) in SQLite and resumes cleanly once the quota window resets.
- **First-Class API Support**: Pay-as-you-go APIs (e.g. OpenCode Go, DeepSeek API, and Stage 4 native OpenAI-compatible HTTP providers) are treated as first-class citizens alongside local CLIs.

---

## 3. Local Web UI & Secret Hygiene

- **Localhost Only by Default**: `baton ui` binds strictly to `127.0.0.1` (do not expose it directly to untrusted public networks without authentication/reverse proxy).
- **Path Traversal Guards**: Static asset serving, RFC path resolution (`/api/runs/start`), and graph validation reject path traversal outside the repository or static build directory.
- **Zero-Secret Repo Policy**: Never store API keys or tokens in `.baton.json`, `baton.toml`, or `.patch.yml` overlays committed to Git. Credentials stay in OS environment variables or local credential stores (such as `~/.dsh/.credentials.yaml`), and runtime `.baton/state.sqlite*`, `.baton/logs/`, `.baton/runs/` are `.gitignore`d.
