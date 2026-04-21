export type RiskLevel = "low" | "medium" | "high";
export type OrchestrationMode = "dispatch" | "advice";
export type PacketStatus =
  | "planning"
  | "dispatching"
  | "reviewing"
  | "awaiting-approval"
  | "awaiting-review"
  | "completed"
  | "cleared";
export type SliceExecutionMode = "same-tree" | "worktree" | "advice";
export type SliceStatus = "planned" | "ready" | "running" | "completed" | "failed" | "blocked" | "reviewed";

export interface SlicePacket {
  id: string;
  title: string;
  goal: string;
  agent: string;
  risk: RiskLevel;
  executionMode: SliceExecutionMode;
  verification: string;
  handoff: string;
  status: SliceStatus;
  reviewedBy?: string;
  notes?: string;
  resultSummary?: string;
}

export interface PendingLaunch {
  sliceId: string;
  agent: string;
  risk: RiskLevel;
  executionMode: SliceExecutionMode;
}

export interface RootPacket {
  id: string;
  request: string;
  cwd: string;
  startedAt: string;
  mode: OrchestrationMode;
  dependency: {
    subagentAvailable: boolean;
  };
  status: PacketStatus;
  summary?: string;
  slices: SlicePacket[];
  pendingLaunch?: PendingLaunch;
  reviewApproved: boolean;
  lastUpdatedAt: string;
}

export interface CreateRootPacketInput {
  request: string;
  cwd: string;
  subagentAvailable: boolean;
  now?: string;
  id?: string;
}

export type SliceInput = Omit<SlicePacket, "status"> & { status?: SliceStatus };

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function touch(packet: RootPacket, now?: string): RootPacket {
  return { ...packet, lastUpdatedAt: now ?? new Date().toISOString() };
}

export function hasSubagentTool(tools: Array<{ name?: string }>): boolean {
  return tools.some((tool) => tool.name === "subagent");
}

export function summarizeText(text: string | null | undefined, maxLength = 240): string {
  const normalized = (text ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return "(no output)";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function createRootPacket(input: CreateRootPacketInput): RootPacket {
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id ?? makeId("orch"),
    request: input.request,
    cwd: input.cwd,
    startedAt: now,
    mode: input.subagentAvailable ? "dispatch" : "advice",
    dependency: {
      subagentAvailable: input.subagentAvailable,
    },
    status: "planning",
    slices: [],
    reviewApproved: false,
    lastUpdatedAt: now,
  };
}

export function setPacketSummary(packet: RootPacket, summary: string): RootPacket {
  return touch({ ...packet, summary: summarizeText(summary, 400) });
}

export function setPacketStatus(packet: RootPacket, status: PacketStatus): RootPacket {
  return touch({ ...packet, status });
}

export function upsertSlice(packet: RootPacket, input: SliceInput): RootPacket {
  const nextSlice: SlicePacket = {
    ...input,
    status: input.status ?? "planned",
  };

  const existingIndex = packet.slices.findIndex((slice) => slice.id === input.id);
  const slices = [...packet.slices];

  if (existingIndex === -1) {
    slices.push(nextSlice);
  } else {
    slices[existingIndex] = nextSlice;
  }

  return touch({ ...packet, slices });
}

export function setPendingLaunch(packet: RootPacket, pendingLaunch: PendingLaunch): RootPacket {
  const slices = packet.slices.map((slice) =>
    slice.id === pendingLaunch.sliceId ? { ...slice, agent: pendingLaunch.agent, status: "running" as const } : slice,
  );

  return touch({
    ...packet,
    status: pendingLaunch.risk === "high" ? "awaiting-approval" : "dispatching",
    pendingLaunch,
    slices,
  });
}

export function clearPendingLaunch(packet: RootPacket): RootPacket {
  return touch({ ...packet, pendingLaunch: undefined, status: "planning" });
}

export function recordHandoff(
  packet: RootPacket,
  input: { sliceId: string; handoff?: string; notes?: string; status?: SliceStatus },
): RootPacket {
  const slices = packet.slices.map((slice) => {
    if (slice.id !== input.sliceId) return slice;
    return {
      ...slice,
      handoff: input.handoff ?? slice.handoff,
      notes: input.notes ?? slice.notes,
      status: input.status ?? slice.status,
    };
  });

  return touch({ ...packet, slices });
}

// ---------------------------------------------------------------------------
// v2 helpers
// ---------------------------------------------------------------------------

export function requiresApprovalForPendingLaunch(packet: RootPacket): boolean {
  return packet.pendingLaunch?.risk === "high";
}

/**
 * A worktree slice requires that the subagent call includes worktree isolation.
 * This predicate checks whether the pending launch targets a worktree-mode slice.
 */
export function pendingLaunchRequiresWorktree(packet: RootPacket): boolean {
  if (!packet.pendingLaunch) return false;
  return packet.pendingLaunch.executionMode === "worktree";
}

/**
 * Validate that subagent call input includes worktree:true when the pending
 * launch requires worktree isolation. Returns true when the input is compliant
 * or when no worktree is required.
 */
export function validateWorktreeCompliance(
  packet: RootPacket,
  subagentInput: Record<string, unknown>,
): { compliant: boolean; message?: string } {
  if (!pendingLaunchRequiresWorktree(packet)) {
    return { compliant: true };
  }

  // pi-subagents exposes worktree as a top-level param on parallel/chain calls
  // and on single calls via the task config
  const hasWorktreeTopLevel = subagentInput.worktree === true;
  const hasWorktreeInTasks =
    Array.isArray(subagentInput.tasks) &&
    (subagentInput.tasks as unknown[]).some(
      (t) => typeof t === "object" && t !== null && "worktree" in (t as Record<string, unknown>),
    );

  if (hasWorktreeTopLevel || hasWorktreeInTasks) {
    return { compliant: true };
  }

  return {
    compliant: false,
    message: `Slice "${packet.pendingLaunch!.sliceId}" requires worktree isolation but the subagent call does not include worktree: true. Add worktree: true to the subagent call parameters.`,
  };
}

/**
 * Mark a slice as reviewed by an agent.
 */
export function reviewSlice(
  packet: RootPacket,
  input: { sliceId: string; reviewer: string },
): RootPacket {
  const slices = packet.slices.map((slice) => {
    if (slice.id !== input.sliceId) return slice;
    return { ...slice, reviewedBy: input.reviewer, status: "reviewed" as const };
  });

  return touch({ ...packet, slices });
}

/**
 * Check whether the packet is ready for final completion.
 * A packet is completable when:
 * - all slices are completed, reviewed, or failed, AND
 * - at least one slice has been reviewed OR review is explicitly approved, AND
 * - no slice is still running, planned, or ready
 */
export function canCompletePacket(packet: RootPacket): { canComplete: boolean; reason?: string } {
  const activeStatuses: SliceStatus[] = ["planned", "ready", "running"];
  const active = packet.slices.filter((s) => activeStatuses.includes(s.status));

  if (active.length > 0) {
    return {
      canComplete: false,
      reason: `Active slices remaining: ${active.map((s) => s.id).join(", ")}`,
    };
  }

  const hasReviewedSlice = packet.slices.some((s) => s.reviewedBy !== undefined || s.status === "reviewed");
  if (!hasReviewedSlice && !packet.reviewApproved) {
    return {
      canComplete: false,
      reason: "No slice has been reviewed yet. Use /orch-review or orch_packet action=review before completing.",
    };
  }

  // Check that any high-risk slice specifically was reviewed or its risk was low/medium
  const highRiskSlices = packet.slices.filter((s) => s.risk === "high");
  const unreviewedHighRisk = highRiskSlices.filter((s) => !s.reviewedBy && s.status !== "reviewed");
  if (unreviewedHighRisk.length > 0 && !packet.reviewApproved) {
    return {
      canComplete: false,
      reason: `High-risk slices not reviewed: ${unreviewedHighRisk.map((s) => s.id).join(", ")}`,
    };
  }

  return { canComplete: true };
}

/**
 * Approve the overall review, allowing completion without per-slice review
 * sign-off. This is a manual gate for when the operator explicitly approves.
 */
export function approveReview(packet: RootPacket): RootPacket {
  return touch({ ...packet, reviewApproved: true, status: "reviewing" });
}

export function recordSubagentResult(
  packet: RootPacket,
  input: { ok: boolean; summary?: string | null | undefined },
): RootPacket {
  if (!packet.pendingLaunch) {
    return touch(packet);
  }

  const summary = summarizeText(input.summary);
  const { sliceId } = packet.pendingLaunch;
  const slices = packet.slices.map((slice) => {
    if (slice.id !== sliceId) return slice;
    return {
      ...slice,
      status: input.ok ? ("completed" as const) : ("failed" as const),
      resultSummary: summary,
    };
  });

  return touch({
    ...packet,
    pendingLaunch: undefined,
    status: input.ok ? "reviewing" : "planning",
    slices,
  });
}

export function completePacket(packet: RootPacket): RootPacket {
  return touch({ ...packet, status: "completed", pendingLaunch: undefined });
}