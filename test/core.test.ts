import test from "node:test";
import assert from "node:assert/strict";

import {
  approveReview,
  canCompletePacket,
  createRootPacket,
  hasSubagentTool,
  pendingLaunchRequiresWorktree,
  recordSubagentResult,
  requiresApprovalForPendingLaunch,
  reviewSlice,
  setPendingLaunch,
  summarizeText,
  upsertSlice,
  validateWorktreeCompliance,
} from "../src/core.ts";

// ---------------------------------------------------------------------------
// v1 tests (preserved)
// ---------------------------------------------------------------------------

test("hasSubagentTool detects the subagent tool", () => {
  assert.equal(hasSubagentTool([{ name: "read" }, { name: "subagent" }]), true);
  assert.equal(hasSubagentTool([{ name: "read" }, { name: "bash" }]), false);
});

test("createRootPacket chooses dispatch mode when subagent exists", () => {
  const packet = createRootPacket({
    request: "add auth hardening",
    cwd: "/repo",
    subagentAvailable: true,
    now: "2026-04-21T22:00:00.000Z",
  });

  assert.equal(packet.mode, "dispatch");
  assert.equal(packet.status, "planning");
  assert.equal(packet.slices.length, 0);
  assert.equal(packet.reviewApproved, false);
});

test("upsertSlice adds then updates a slice", () => {
  const packet = createRootPacket({
    request: "ship feature",
    cwd: "/repo",
    subagentAvailable: true,
    now: "2026-04-21T22:00:00.000Z",
  });

  const created = upsertSlice(packet, {
    id: "slice-1",
    title: "Implement API",
    goal: "Add the endpoint",
    agent: "worker",
    risk: "medium",
    executionMode: "same-tree",
    verification: "run targeted tests",
    handoff: "report files and risks",
  });

  assert.equal(created.slices.length, 1);
  assert.equal(created.slices[0]?.status, "planned");

  const updated = upsertSlice(created, {
    id: "slice-1",
    title: "Implement API",
    goal: "Add the endpoint and wire validation",
    agent: "worker",
    risk: "high",
    executionMode: "worktree",
    verification: "run targeted tests",
    handoff: "report files and risks",
    status: "ready",
  });

  assert.equal(updated.slices.length, 1);
  assert.equal(updated.slices[0]?.risk, "high");
  assert.equal(updated.slices[0]?.executionMode, "worktree");
  assert.equal(updated.slices[0]?.status, "ready");
});

test("requiresApprovalForPendingLaunch is true only for high risk launches", () => {
  const packet = createRootPacket({
    request: "ship feature",
    cwd: "/repo",
    subagentAvailable: true,
    now: "2026-04-21T22:00:00.000Z",
  });

  const withLowRisk = {
    ...packet,
    pendingLaunch: { sliceId: "slice-1", agent: "worker", risk: "low", executionMode: "same-tree" as const },
  };
  const withHighRisk = {
    ...packet,
    pendingLaunch: { sliceId: "slice-1", agent: "worker", risk: "high", executionMode: "worktree" as const },
  };

  assert.equal(requiresApprovalForPendingLaunch(withLowRisk), false);
  assert.equal(requiresApprovalForPendingLaunch(withHighRisk), true);
});

test("recordSubagentResult clears pending launch and records outcome", () => {
  const packet = upsertSlice(
    {
      ...createRootPacket({
        request: "ship feature",
        cwd: "/repo",
        subagentAvailable: true,
        now: "2026-04-21T22:00:00.000Z",
      }),
      pendingLaunch: { sliceId: "slice-1", agent: "worker", risk: "high", executionMode: "worktree" as const },
      status: "dispatching" as const,
    },
    {
      id: "slice-1",
      title: "Implement API",
      goal: "Add the endpoint",
      agent: "worker",
      risk: "high",
      executionMode: "worktree",
      verification: "run targeted tests",
      handoff: "report files and risks",
      status: "running",
    },
  );

  const result = recordSubagentResult(packet, {
    ok: true,
    summary: "Implemented the API and ran targeted tests successfully.",
  });

  assert.equal(result.pendingLaunch, undefined);
  assert.equal(result.status, "reviewing");
  assert.equal(result.slices[0]?.status, "completed");
  assert.match(result.slices[0]?.resultSummary ?? "", /Implemented the API/);
});

test("summarizeText trims whitespace and truncates long text", () => {
  assert.equal(summarizeText("  hello world  "), "hello world");
  assert.equal(summarizeText(""), "(no output)");
  assert.equal(summarizeText("a".repeat(300), 32), `${"a".repeat(29)}...`);
});

// ---------------------------------------------------------------------------
// v2 tests
// ---------------------------------------------------------------------------

test("pendingLaunchRequiresWorktree returns true only for worktree launches", () => {
  const base = createRootPacket({ request: "x", cwd: "/r", subagentAvailable: true });

  const sameTree = setPendingLaunch(base, {
    sliceId: "s1", agent: "worker", risk: "low", executionMode: "same-tree",
  });
  assert.equal(pendingLaunchRequiresWorktree(sameTree), false);

  const worktree = setPendingLaunch(base, {
    sliceId: "s1", agent: "worker", risk: "low", executionMode: "worktree",
  });
  assert.equal(pendingLaunchRequiresWorktree(worktree), true);
});

test("pendingLaunchRequiresWorktree returns false when no pending launch", () => {
  const base = createRootPacket({ request: "x", cwd: "/r", subagentAvailable: true });
  assert.equal(pendingLaunchRequiresWorktree(base), false);
});

test("validateWorktreeCompliance passes when worktree not required", () => {
  const base = upsertSlice(
    setPendingLaunch(
      createRootPacket({ request: "x", cwd: "/r", subagentAvailable: true }),
      { sliceId: "s1", agent: "worker", risk: "low", executionMode: "same-tree" },
    ),
    { id: "s1", title: "t", goal: "g", agent: "worker", risk: "low", executionMode: "same-tree", verification: "v", handoff: "h" },
  );

  const result = validateWorktreeCompliance(base, { agent: "worker", task: "do it" });
  assert.equal(result.compliant, true);
  assert.equal(result.message, undefined);
});

test("validateWorktreeCompliance passes when worktree is required and call includes it at top level", () => {
  const base = upsertSlice(
    setPendingLaunch(
      createRootPacket({ request: "x", cwd: "/r", subagentAvailable: true }),
      { sliceId: "s1", agent: "worker", risk: "medium", executionMode: "worktree" },
    ),
    { id: "s1", title: "t", goal: "g", agent: "worker", risk: "medium", executionMode: "worktree", verification: "v", handoff: "h" },
  );

  const result = validateWorktreeCompliance(base, { worktree: true, tasks: [{ agent: "worker", task: "go" }] });
  assert.equal(result.compliant, true);
});

test("validateWorktreeCompliance fails when worktree is required but not in call", () => {
  const base = upsertSlice(
    setPendingLaunch(
      createRootPacket({ request: "x", cwd: "/r", subagentAvailable: true }),
      { sliceId: "s1", agent: "worker", risk: "medium", executionMode: "worktree" },
    ),
    { id: "s1", title: "t", goal: "g", agent: "worker", risk: "medium", executionMode: "worktree", verification: "v", handoff: "h" },
  );

  const result = validateWorktreeCompliance(base, { agent: "worker", task: "go" });
  assert.equal(result.compliant, false);
  assert.match(result.message ?? "", /worktree.*true/);
});

test("reviewSlice marks a slice as reviewed", () => {
  const base = upsertSlice(
    createRootPacket({ request: "x", cwd: "/r", subagentAvailable: true }),
    { id: "s1", title: "t", goal: "g", agent: "worker", risk: "medium", executionMode: "same-tree", verification: "v", handoff: "h", status: "completed" },
  );

  const reviewed = reviewSlice(base, { sliceId: "s1", reviewer: "reviewer" });
  assert.equal(reviewed.slices[0]?.reviewedBy, "reviewer");
  assert.equal(reviewed.slices[0]?.status, "reviewed");
});

test("canCompletePacket blocks when active slices remain", () => {
  const base = upsertSlice(
    createRootPacket({ request: "x", cwd: "/r", subagentAvailable: true }),
    { id: "s1", title: "t", goal: "g", agent: "worker", risk: "low", executionMode: "same-tree", verification: "v", handoff: "h", status: "running" },
  );

  const result = canCompletePacket(base);
  assert.equal(result.canComplete, false);
  assert.match(result.reason ?? "", /Active slice/);
});

test("canCompletePacket blocks when no review has happened", () => {
  let base = createRootPacket({ request: "x", cwd: "/r", subagentAvailable: true });
  base = upsertSlice(base, {
    id: "s1", title: "t", goal: "g", agent: "worker", risk: "low", executionMode: "same-tree",
    verification: "v", handoff: "h", status: "completed",
  });

  const result = canCompletePacket(base);
  assert.equal(result.canComplete, false);
  assert.match(result.reason ?? "", /No slice has been reviewed/);
});

test("canCompletePacket allows completion after review approval", () => {
  let base = createRootPacket({ request: "x", cwd: "/r", subagentAvailable: true });
  base = upsertSlice(base, {
    id: "s1", title: "t", goal: "g", agent: "worker", risk: "low", executionMode: "same-tree",
    verification: "v", handoff: "h", status: "completed",
  });
  base = approveReview(base);

  const result = canCompletePacket(base);
  assert.equal(result.canComplete, true);
});

test("canCompletePacket allows completion after per-slice review", () => {
  let base = createRootPacket({ request: "x", cwd: "/r", subagentAvailable: true });
  base = upsertSlice(base, {
    id: "s1", title: "t", goal: "g", agent: "worker", risk: "medium", executionMode: "same-tree",
    verification: "v", handoff: "h", status: "completed",
  });
  base = reviewSlice(base, { sliceId: "s1", reviewer: "reviewer" });

  const result = canCompletePacket(base);
  assert.equal(result.canComplete, true);
});

test("canCompletePacket blocks when high-risk slice is unreviewed", () => {
  let base = createRootPacket({ request: "x", cwd: "/r", subagentAvailable: true });
  base = upsertSlice(base, {
    id: "s1", title: "t", goal: "g", agent: "worker", risk: "high", executionMode: "worktree",
    verification: "v", handoff: "h", status: "completed",
  });

  const result = canCompletePacket(base);
  assert.equal(result.canComplete, false);
  // Either "no review" or "high-risk unreviewed" is valid; what matters is the block
  assert.ok(result.reason, `expected a blocking reason, got: ${result.reason}`);
});

test("canCompletePacket allows completion when high-risk slice is reviewed", () => {
  let base = createRootPacket({ request: "x", cwd: "/r", subagentAvailable: true });
  base = upsertSlice(base, {
    id: "s1", title: "t", goal: "g", agent: "worker", risk: "high", executionMode: "worktree",
    verification: "v", handoff: "h", status: "completed",
  });
  base = reviewSlice(base, { sliceId: "s1", reviewer: "reviewer" });

  const result = canCompletePacket(base);
  assert.equal(result.canComplete, true);
});

test("approveReview sets reviewApproved flag", () => {
  const base = createRootPacket({ request: "x", cwd: "/r", subagentAvailable: true });
  const approved = approveReview(base);
  assert.equal(approved.reviewApproved, true);
  assert.equal(approved.status, "reviewing");
});