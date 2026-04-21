import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  approveReview,
  canCompletePacket,
  clearPendingLaunch,
  completePacket,
  createRootPacket,
  hasSubagentTool,
  pendingLaunchRequiresWorktree,
  recordHandoff,
  recordSubagentResult,
  requiresApprovalForPendingLaunch,
  reviewSlice,
  setPacketStatus,
  setPacketSummary,
  setPendingLaunch,
  summarizeText,
  upsertSlice,
  validateWorktreeCompliance,
  type PacketStatus,
  type RiskLevel,
  type RootPacket,
  type SliceExecutionMode,
  type SliceInput,
} from "./core.ts";

const STATE_TYPE = "orch-packet-state";
const STATUS_KEY = "orch";
const WIDGET_KEY = "orch-slices";
const MAX_WIDGET_SLICES = 6;

const RiskSchema = StringEnum(["low", "medium", "high"] as const, {
  description: "Risk level for a delegated slice",
});
const PacketStatusSchema = StringEnum(
  ["planning", "dispatching", "reviewing", "awaiting-approval", "awaiting-review", "completed", "cleared"] as const,
  {
    description: "Overall orchestration packet status",
  },
);
const ExecutionModeSchema = StringEnum(["same-tree", "worktree", "advice"] as const, {
  description: "How a slice should execute",
});
const OrchestratorActionSchema = StringEnum(
  [
    "get",
    "set_summary",
    "upsert_slice",
    "prepare_launch",
    "record_handoff",
    "set_status",
    "clear_pending_launch",
    "review",
    "approve_review",
    "complete",
  ] as const,
  { description: "Orchestration packet action" },
);

const SliceSchema = Type.Object({
  id: Type.String({ description: "Stable slice id, e.g. slice-1" }),
  title: Type.String({ description: "Short slice title" }),
  goal: Type.String({ description: "What this slice should accomplish" }),
  agent: Type.String({ description: "Agent that owns the slice" }),
  risk: RiskSchema,
  executionMode: ExecutionModeSchema,
  verification: Type.String({ description: "Verification to run or require" }),
  handoff: Type.String({ description: "Expected handoff back to orchestrator" }),
  status: Type.Optional(
    StringEnum(["planned", "ready", "running", "completed", "failed", "blocked", "reviewed"] as const, {
      description: "Current slice status",
    }),
  ),
  reviewedBy: Type.Optional(Type.String({ description: "Agent that reviewed this slice" })),
  notes: Type.Optional(Type.String({ description: "Optional notes or caveats" })),
  resultSummary: Type.Optional(Type.String({ description: "Optional compact result summary" })),
});

const LaunchSchema = Type.Object({
  sliceId: Type.String({ description: "Slice id being launched" }),
  agent: Type.String({ description: "Agent used for the launch" }),
  risk: RiskSchema,
  executionMode: ExecutionModeSchema,
});

const OrchestratorPacketParams = Type.Object({
  action: OrchestratorActionSchema,
  summary: Type.Optional(Type.String({ description: "Root packet summary" })),
  status: Type.Optional(PacketStatusSchema),
  slice: Type.Optional(SliceSchema),
  launch: Type.Optional(LaunchSchema),
  sliceId: Type.Optional(Type.String({ description: "Slice id for targeted updates" })),
  reviewer: Type.Optional(Type.String({ description: "Reviewer agent name for review action" })),
  handoff: Type.Optional(Type.String({ description: "Recorded handoff text" })),
  notes: Type.Optional(Type.String({ description: "Optional notes for the slice" })),
});

type PacketStateEntry = {
  type: "custom";
  customType?: string;
  data?: { packet: RootPacket | null };
};

function packetLines(packet: RootPacket): string[] {
  const completed = packet.slices.filter((slice) => slice.status === "completed" || slice.status === "reviewed").length;
  const failed = packet.slices.filter((slice) => slice.status === "failed").length;
  const reviewed = packet.slices.filter((slice) => slice.reviewedBy !== undefined).length;
  const header = [
    `id=${packet.id}`,
    `mode=${packet.mode}`,
    `status=${packet.status}`,
    `slices=${completed}/${packet.slices.length}`,
    `reviewed=${reviewed}`,
  ];
  if (failed > 0) header.push(`failed=${failed}`);
  if (packet.reviewApproved) header.push("review-approved");
  if (packet.pendingLaunch) {
    header.push(
      `pending=${packet.pendingLaunch.sliceId}:${packet.pendingLaunch.agent}:${packet.pendingLaunch.risk}:${packet.pendingLaunch.executionMode}`,
    );
  }

  const lines = [header.join(" | "), `request: ${summarizeText(packet.request, 140)}`];
  if (packet.summary) lines.push(`summary: ${packet.summary}`);
  for (const slice of packet.slices.slice(0, MAX_WIDGET_SLICES)) {
    const reviewBadge = slice.reviewedBy ? `[rv:${slice.reviewedBy}]` : "";
    lines.push(
      `- ${slice.id} [${slice.status}] ${slice.agent} ${slice.executionMode} ${slice.risk}${reviewBadge} :: ${summarizeText(slice.title, 80)}`,
    );
  }
  if (packet.slices.length > MAX_WIDGET_SLICES) {
    lines.push(`- ... ${packet.slices.length - MAX_WIDGET_SLICES} more slice(s)`);
  }
  return lines;
}

function extractTextContent(content: Array<{ type: string; text?: string }> | undefined): string {
  if (!content || content.length === 0) return "";
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");
}

function restorePacket(ctx: ExtensionContext): RootPacket | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as PacketStateEntry;
    if (entry.type === "custom" && entry.customType === STATE_TYPE) {
      return entry.data?.packet ?? undefined;
    }
  }
  return undefined;
}

function buildKickoffPrompt(packet: RootPacket): string {
  const modeLine =
    packet.mode === "dispatch"
      ? "Real delegated execution is available. Use subagent-driven work by default when it helps."
      : "subagent is unavailable in this session. Stay in advice/plan mode and do not pretend to delegate.";

  return [
    "[ORCHESTRATION PACKET ACTIVE v2]",
    `Packet id: ${packet.id}`,
    `Mode: ${packet.mode}`,
    modeLine,
    "",
    "Protocol:",
    "1. Call orch_packet with action=get first to inspect state.",
    "2. If the request is materially ambiguous, ask one clarifying question before decomposition or delegation.",
    "3. Decompose only when it genuinely helps. Prefer 2-5 mostly independent vertical slices.",
    "4. Before each delegated subagent run, call orch_packet with action=prepare_launch using the slice id, agent, risk, and execution mode.",
    "5. IMPORTANT: If executionMode is worktree, include worktree:true in the subagent call parameters. Same-tree is the default.",
    "6. After each delegated run, record the handoff and any notes back into orch_packet.",
    "7. Keep verification and unresolved risk explicit.",
    "8. Before completing, call orch_packet with action=review for each completed slice, or use action=approve_review to sign off on the whole packet.",
    "9. End with the next best integration/review step, not fluff.",
    "",
    "Current packet:",
    ...packetLines(packet),
  ].join("\n");
}

export default function orchestratorExtension(pi: ExtensionAPI) {
  let activePacket: RootPacket | undefined;

  const persistState = () => {
    pi.appendEntry(STATE_TYPE, { packet: activePacket ?? null });
  };

  const updateUi = (ctx: ExtensionContext) => {
    if (!activePacket) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    const completed = activePacket.slices.filter((s) => s.status === "completed" || s.status === "reviewed").length;
    const reviewed = activePacket.slices.filter((s) => s.reviewedBy !== undefined).length;
    const statusColor =
      activePacket.status === "awaiting-approval"
        ? "warning"
        : activePacket.status === "awaiting-review"
          ? "warning"
          : "accent";
    const footer = ctx.ui.theme.fg(
      statusColor,
      `orch:${activePacket.mode}:${activePacket.status}:${completed}/${activePacket.slices.length}:rv${reviewed}`,
    );
    ctx.ui.setStatus(STATUS_KEY, footer);
    ctx.ui.setWidget(WIDGET_KEY, packetLines(activePacket));
  };

  const commitPacket = (packet: RootPacket | undefined, ctx?: ExtensionContext) => {
    activePacket = packet;
    persistState();
    if (ctx) updateUi(ctx);
  };

  pi.registerCommand("orch", {
    description: "Start orchestrated work for a request",
    handler: async (args, ctx) => {
      const request = args.trim();
      if (!request) {
        ctx.ui.notify("Usage: /orch <request>", "warning");
        return;
      }

      const subagentAvailable = hasSubagentTool(pi.getAllTools());
      const packet = createRootPacket({
        request,
        cwd: ctx.cwd,
        subagentAvailable,
      });
      commitPacket(packet, ctx);
      pi.setSessionName(`Orch: ${summarizeText(request, 48)}`);

      if (subagentAvailable) {
        ctx.ui.notify("Orchestration packet started. Dispatch mode is active.", "info");
      } else {
        ctx.ui.notify(
          "Orchestration packet started in advice mode. Install pi-subagents for real delegated execution.",
          "warning",
        );
      }

      if (ctx.isIdle()) {
        pi.sendUserMessage(request);
      } else {
        pi.sendUserMessage(request, { deliverAs: "followUp" });
        ctx.ui.notify("Orchestration request queued as follow-up.", "info");
      }
    },
  });

  pi.registerCommand("orch-status", {
    description: "Show the active orchestration packet",
    handler: async (_args, ctx) => {
      if (!activePacket) {
        ctx.ui.notify("No active orchestration packet.", "info");
        return;
      }
      ctx.ui.notify(packetLines(activePacket).join("\n"), "info");
    },
  });

  pi.registerCommand("orch-clear", {
    description: "Clear the active orchestration packet",
    handler: async (_args, ctx) => {
      commitPacket(undefined, ctx);
      ctx.ui.notify("Cleared active orchestration packet.", "info");
    },
  });

  pi.registerCommand("orch-review", {
    description: "Review a slice or approve the whole packet for completion",
    handler: async (args, ctx) => {
      if (!activePacket) {
        ctx.ui.notify("No active orchestration packet.", "info");
        return;
      }

      const trimmed = args.trim();

      // /orch-review approve  →  approve the whole packet
      if (trimmed === "approve") {
        commitPacket(approveReview(activePacket), ctx);
        ctx.ui.notify("Review approved for entire packet.", "info");
        return;
      }

      // /orch-review <sliceId> [reviewer]  →  review a specific slice
      const parts = trimmed.split(/\s+/);
      const sliceId = parts[0];
      const reviewer = parts[1] ?? "operator";

      if (!sliceId) {
        ctx.ui.notify("Usage: /orch-review <sliceId> [reviewer] | /orch-review approve", "warning");
        return;
      }

      const slice = activePacket.slices.find((s) => s.id === sliceId);
      if (!slice) {
        ctx.ui.notify(`Slice "${sliceId}" not found.`, "warning");
        return;
      }

      commitPacket(reviewSlice(activePacket, { sliceId, reviewer }), ctx);
      ctx.ui.notify(`Slice "${sliceId}" reviewed by ${reviewer}.`, "info");
    },
  });

  pi.registerTool({
    name: "orch_packet",
    label: "Orch Packet",
    description: "Manage the active orchestration packet for multi-slice delegated work.",
    promptSnippet: "Inspect and update the active orchestration packet before and after delegated work.",
    promptGuidelines: [
      "Use orch_packet action=get before delegated work to inspect current orchestration state.",
      "Use orch_packet action=prepare_launch before every delegated subagent run so risk and execution mode are explicit.",
      "Use orch_packet action=review after each slice completes to mark it as reviewed.",
      "Use orch_packet action=approve_review or /orch-review approve to sign off on the entire packet before completing.",
      "Use orch_packet action=complete only after review is signed off.",
      "Record handoff details and unresolved risks in orch_packet instead of leaving them implicit.",
    ],
    parameters: OrchestratorPacketParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const ensureActivePacket = (): { content: Array<{ type: "text"; text: string }>; details: { packet: RootPacket | null } } | null => {
        if (!activePacket) {
          return {
            content: [{ type: "text" as const, text: "No active orchestration packet. Ask the user to run /orch first." }],
            details: { packet: null },
          };
        }
        return null;
      };

      if (params.action === "get") {
        return {
          content: [{ type: "text", text: activePacket ? packetLines(activePacket).join("\n") : "No active orchestration packet." }],
          details: { packet: activePacket ?? null },
        };
      }

      const missingPacket = ensureActivePacket();
      if (missingPacket) return missingPacket;

      let nextPacket = activePacket as RootPacket;

      switch (params.action) {
        case "set_summary": {
          nextPacket = setPacketSummary(nextPacket, params.summary ?? "");
          break;
        }
        case "upsert_slice": {
          if (!params.slice) throw new Error("slice is required for upsert_slice");
          nextPacket = upsertSlice(nextPacket, params.slice as SliceInput);
          break;
        }
        case "prepare_launch": {
          if (!params.launch) throw new Error("launch is required for prepare_launch");
          nextPacket = setPendingLaunch(nextPacket, {
            sliceId: params.launch.sliceId,
            agent: params.launch.agent,
            risk: params.launch.risk as RiskLevel,
            executionMode: params.launch.executionMode as SliceExecutionMode,
          });
          break;
        }
        case "record_handoff": {
          if (!params.sliceId) throw new Error("sliceId is required for record_handoff");
          nextPacket = recordHandoff(nextPacket, {
            sliceId: params.sliceId,
            handoff: params.handoff,
            notes: params.notes,
          });
          break;
        }
        case "set_status": {
          if (!params.status) throw new Error("status is required for set_status");
          nextPacket = setPacketStatus(nextPacket, params.status as PacketStatus);
          break;
        }
        case "clear_pending_launch": {
          nextPacket = clearPendingLaunch(nextPacket);
          break;
        }
        case "review": {
          if (!params.sliceId) throw new Error("sliceId is required for review");
          nextPacket = reviewSlice(nextPacket, {
            sliceId: params.sliceId,
            reviewer: params.reviewer ?? "orchestrator",
          });
          break;
        }
        case "approve_review": {
          nextPacket = approveReview(nextPacket);
          break;
        }
        case "complete": {
          const check = canCompletePacket(nextPacket);
          if (!check.canComplete) {
            commitPacket(nextPacket, ctx);
            return {
              content: [{ type: "text", text: `Cannot complete: ${check.reason}` }],
              details: { packet: nextPacket },
            };
          }
          nextPacket = completePacket(nextPacket);
          break;
        }
      }

      commitPacket(nextPacket, ctx);
      return {
        content: [{ type: "text", text: packetLines(nextPacket).join("\n") }],
        details: { packet: nextPacket },
      };
    },
  });

  pi.on("before_agent_start", async (_event, _ctx) => {
    if (!activePacket) return;
    return {
      message: {
        customType: "orch-packet-protocol",
        content: buildKickoffPrompt(activePacket),
        display: false,
      },
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "subagent" || !activePacket) return;

    // --- v2: worktree compliance gate ---
    if (activePacket.pendingLaunch && pendingLaunchRequiresWorktree(activePacket)) {
      const compliance = validateWorktreeCompliance(activePacket, event.input as Record<string, unknown>);
      if (!compliance.compliant) {
        return {
          block: true,
          reason: compliance.message ?? "Worktree isolation required but not included in subagent call.",
        };
      }
    }

    // --- v1: high-risk approval gate ---
    if (activePacket.pendingLaunch && requiresApprovalForPendingLaunch(activePacket)) {
      if (!ctx.hasUI) {
        commitPacket(setPacketStatus(activePacket, "awaiting-approval"), ctx);
        return {
          block: true,
          reason: "High-risk delegated launch requires interactive approval.",
        };
      }

      const launch = activePacket.pendingLaunch;
      const slice = activePacket.slices.find((s) => s.id === launch.sliceId);
      const ok = await ctx.ui.confirm(
        "Approve high-risk delegated launch?",
        [
          `Slice: ${launch.sliceId}${slice ? ` (${slice.title})` : ""}`,
          `Agent: ${launch.agent}`,
          `Risk: ${launch.risk}`,
          `Execution mode: ${launch.executionMode}`,
          slice ? `Goal: ${slice.goal}` : undefined,
          slice ? `Verification: ${slice.verification}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      );

      if (!ok) {
        commitPacket(setPacketStatus(activePacket, "awaiting-approval"), ctx);
        return {
          block: true,
          reason: "High-risk delegated launch not approved by user.",
        };
      }

      commitPacket(setPacketStatus(activePacket, "dispatching"), ctx);
      return;
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "subagent" || !activePacket?.pendingLaunch) return;

    const text = extractTextContent(event.content as Array<{ type: string; text?: string }> | undefined);
    commitPacket(
      recordSubagentResult(activePacket, {
        ok: !event.isError,
        summary: summarizeText(text),
      }),
      ctx,
    );
  });

  pi.on("session_start", async (_event, ctx) => {
    activePacket = restorePacket(ctx);
    updateUi(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    activePacket = restorePacket(ctx);
    updateUi(ctx);
  });
}