# Global Pi Orchestrator Extension

Global Pi extension that adds a lightweight orchestration layer across repositories.

## What it adds
- `/orch <request>` — start an orchestrated task
- `/orch-status` — inspect the active packet
- `/orch-clear` — clear the active packet
- `/orch-review <sliceId> [reviewer]` — mark a specific slice as reviewed
- `/orch-review approve` — approve the whole packet for completion
- `orch_packet` tool — lets the model manage explicit orchestration state

## Three hard gates
1. **High-risk approval**: when a slice is marked `high` risk, the extension requires explicit user approval before the subagent launch proceeds.
2. **Worktree compliance**: when a slice requires `worktree` execution mode, the extension blocks subagent calls that do not include `worktree: true`.
3. **Reviewer gate**: the packet cannot be marked `completed` until at least one slice has been reviewed or the operator has explicitly approved the whole packet.

## Dependency model
- Preferred path: `pi-subagents` installed and its `subagent` tool available
- Fallback path: if `subagent` is unavailable, `/orch` still works in advice/plan mode

## v2 behavior
- keeps one active orchestration packet per session branch
- persists packet state in session entries
- nudges the model to:
  - inspect packet state first
  - decompose only when useful
  - prefer vertical slices
  - prepare launches explicitly before subagent dispatch
  - include `worktree: true` when slices need worktree isolation
  - record handoffs after delegated work
  - review slices or approve the whole packet before completing
- requires approval before high-risk delegated launches
- requires `worktree: true` in subagent calls for worktree-tagged slices
- requires review sign-off before packet completion

## Usage
1. Start Pi normally.
2. Run `/reload`.
3. Start work with:
   - `/orch add feature X`
   - `/orch investigate bug Y`
4. Check state with `/orch-status`.
5. Review slices with `/orch-review <sliceId> [reviewer]`.
6. Approve whole packet with `/orch-review approve`.
7. Clear state with `/orch-clear`.

## Recommended Agent Configuration

Deploy user-level agent overrides at `~/.pi/agent/agents/` to pair with the orchestrator:

| Agent | Model | Thinking | Role |
|-------|-------|----------|------|
| `scout` | `deepseek-v4-flash` | `medium` | Fast recon — grep/read/find only, no writes |
| `planner` | `deepseek-v4-pro` | `high` | Turn recon + requirements into dispatchable plans |
| `worker` | `deepseek-v4-pro` | `high` | Implement one narrow slice, follow existing patterns |
| `reviewer` | `deepseek-v4-pro` | `high` | Validate against plan, fix only real issues |

Keep agent prompts lean (~20 lines). Remove orch-specific ceremony — the orchestrator injects protocol instructions via the task string. Focus each agent on its role: what to do, how to do it, and the output format.

## Performance: Fast Path vs Full Pipeline

The orchestrator supports a fast path for simple work — skip scout, planner, and reviewer, dispatch a single worker directly:

- **Fast Path**: ≤3 files, follows existing patterns, no new domain types or DB schema, low risk. One `subagent({ agent: "worker" })` call.
- **Full Pipeline**: Multi-module changes, new types, DB migrations, high risk or unknown territory. `scout → planner → worker(s) → reviewer(s)`.

Default to fast path. Only pull the full pipeline when complexity genuinely demands it. For multi-slice work, dispatch independent slices in parallel.

## Notes
- This extension is global because it lives under `~/.pi/agent/extensions/orchestrator/`.
- It does not replace `pi-subagents`; it orchestrates around it.
- Pair with user-level agent overrides (`~/.pi/agent/agents/`) for `scout`, `planner`, `worker`, and `reviewer`.

## Changelog
- **v2.1**: Added recommended agent configuration (deepseek-v4-pro/flash, thinking levels, lean prompts). Added fast path vs full pipeline guidance. Scout on flash for recon speed.
- **v2**: Added worktree compliance gate, reviewer gate (`review`, `approve_review`, `/orch-review`), `awaiting-review` status, `reviewedBy` and `reviewApproved` fields, and updated protocol to enforce slices and review.
- **v1**: Initial release with `/orch`, `/orch-status`, `/orch-clear`, `orch_packet` tool, high-risk approval gate, and subagent result capture.