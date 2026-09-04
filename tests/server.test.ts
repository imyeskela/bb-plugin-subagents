import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

type ThreadListItem = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["list"]>
>[number];
type ThreadTimelineResult = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["timeline"]>
>;
type TimelineRow = ThreadTimelineResult["rows"][number];
type DelegationRow = Extract<TimelineRow, { kind: "work"; workKind: "delegation" }>;

function delegation(id: string, childRows: TimelineRow[] = []): DelegationRow {
  return {
    id,
    kind: "work",
    workKind: "delegation",
    status: "pending",
    createdAt: 10,
    startedAt: 10,
    sourceSeqStart: 1,
    sourceSeqEnd: 4,
    threadId: "root",
    turnId: "turn-1",
    callId: id,
    toolName: "delegation",
    childRef: id,
    background: false,
    subagentType: "worker",
    description: id,
    output: "",
    completedAt: null,
    childRows,
  };
}

function timeline(rows: TimelineRow[]): ThreadTimelineResult {
  return {
    activeBackgroundCommands: [],
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    goal: null,
    maxSeq: 1,
    modelFallback: null,
    pendingTodos: null,
    rows,
    timelinePage: {
      hasOlderRows: false,
      kind: "latest",
      olderCursor: null,
      returnedSegmentCount: rows.length,
      segmentLimit: 100,
    },
  };
}

function thread(
  id: string,
  parentThreadId: string,
  overrides: Partial<ThreadListItem> = {},
): ThreadListItem {
  return {
    id,
    projectId: "project-1",
    environmentId: "environment-1",
    providerId: "codex",
    title: id,
    titleFallback: null,
    sectionId: null,
    status: "idle",
    parentThreadId,
    sourceThreadId: null,
    originKind: "fork",
    originPluginId: null,
    visibility: "visible",
    archivedAt: null,
    pinnedAt: null,
    deletedAt: null,
    lastReadAt: null,
    latestAttentionAt: 1,
    createdAt: 1,
    updatedAt: 1,
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    queuedWork: "none",
    pinSortKey: null,
    environmentBranchName: null,
    environmentHostId: "host-1",
    environmentName: null,
    environmentWorkspaceDisplayKind: "other",
    hasPendingInteraction: false,
    runtime: {
      displayStatus: "idle",
      hostReconnectGraceExpiresAt: null,
    },
    ...overrides,
  };
}

describe("Subagents backend", () => {
  it("lists nested and hidden descendants with execution metadata", async () => {
    const direct = thread("child-1", "root", {
      status: "active",
      visibility: "hidden",
      runtime: { displayStatus: "active", hostReconnectGraceExpiresAt: null },
    });
    const nested = thread("grandchild-1", "child-1");
    const { bb, harness } = createFakePluginHost({
      pluginId: "subagents",
      sdk: {
        threads: {
          list: async (args) => {
            const parentThreadId = args?.parentThreadId;
            if (parentThreadId === "root") return [direct];
            if (parentThreadId === "child-1") return [nested];
            return [];
          },
          timeline: async () => timeline([]),
          defaultExecutionOptions: async ({ threadId }) => ({
            model: threadId === "child-1" ? "gpt-5.6-sol" : "gpt-5.6-luna",
            reasoningLevel: "high",
            serviceTier: "default",
            permissionMode: "accept-edits",
            source: "client/thread/start",
          }),
        },
      },
    });
    await plugin(bb);

    const result = await harness.behavior.callRpc("subagents_list", {
      rootThreadId: "root",
    });

    expect(result).toEqual({
      agents: [
        expect.objectContaining({
          id: "child-1",
          parentThreadId: "root",
          visibility: "hidden",
          execution: expect.objectContaining({ model: "gpt-5.6-sol" }),
        }),
        expect.objectContaining({
          id: "grandchild-1",
          parentThreadId: "child-1",
          execution: expect.objectContaining({ model: "gpt-5.6-luna" }),
        }),
      ],
      truncated: false,
    });
    expect(harness.inspection.sdk.callsTo("threads.list")[0]?.[0]).toEqual(
      expect.objectContaining({ includeHidden: true, archived: false }),
    );
    await harness.lifecycle.dispose();
  });

  it("lists native delegations without attributing the root's execution settings to them", async () => {
    const root = makeThreadResponse({
      id: "root",
      projectId: "project-1",
      providerId: "codex",
    });
    const delegation = {
      id: "root:delegation:call-1",
      kind: "work",
      workKind: "delegation",
      status: "pending",
      createdAt: 10,
      startedAt: 10,
      sourceSeqStart: 1,
      sourceSeqEnd: 4,
      threadId: "root",
      turnId: "turn-1",
      callId: "call-1",
      toolName: "delegation",
      childRef: "child-ref-1",
      background: true,
      subagentType: "worker",
      description: "/root/check_api",
      output: "",
      completedAt: null,
      childRows: [
        {
          id: "child-message-1",
          kind: "conversation",
          role: "assistant",
          text: "Checking the API now.",
          attachments: null,
          createdAt: 11,
          startedAt: 11,
          sourceSeqStart: 2,
          sourceSeqEnd: 3,
          threadId: "root",
          turnId: "turn-1",
          turnRequest: null,
        },
      ],
    } as TimelineRow;
    const { bb, harness } = createFakePluginHost({
      pluginId: "subagents",
      sdk: {
        threads: {
          list: async () => [],
          timeline: async () => timeline([delegation]),
          get: async () => root,
          defaultExecutionOptions: async () => ({
            model: "gpt-5.6-sol",
            reasoningLevel: "high",
            serviceTier: "default",
            permissionMode: "accept-edits",
            source: "client/thread/start",
          }),
        },
      },
    });
    await plugin(bb);

    const result = await harness.behavior.callRpc("subagents_list", {
      rootThreadId: "root",
    });

    expect(result).toEqual({
      agents: [
        expect.objectContaining({
          id: "root:delegation:call-1",
          projectId: "project-1",
          kind: "delegation",
          relationship: "delegation",
          chatThreadId: null,
          execution: null,
          messages: [
            expect.objectContaining({
              role: "assistant",
              text: "Checking the API now.",
            }),
          ],
        }),
      ],
      truncated: false,
    });
    expect(harness.inspection.sdk.callsTo("threads.defaultExecutionOptions")).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("preserves native delegation parents independently of their names", async () => {
    const nested = delegation("ssrf sandbox review");
    const backend = delegation("backend review", [nested]);
    const frontend = delegation("frontend review");
    const { bb, harness } = createFakePluginHost({
      pluginId: "subagents",
      sdk: {
        threads: {
          list: async () => [],
          timeline: async () => timeline([backend, frontend]),
          get: async () => makeThreadResponse({ id: "root" }),
          defaultExecutionOptions: async () => null,
        },
      },
    });
    await plugin(bb);

    const result = await harness.behavior.callRpc("subagents_list", {
      rootThreadId: "root",
    });

    expect(result).toEqual({
      agents: [
        expect.objectContaining({ id: backend.id, parentThreadId: "root" }),
        expect.objectContaining({ id: nested.id, parentThreadId: backend.id }),
        expect.objectContaining({ id: frontend.id, parentThreadId: "root" }),
      ],
      truncated: false,
    });
    await harness.lifecycle.dispose();
  });

  it("publishes a refetch signal for thread lifecycle changes", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "subagents",
      sdk: {
        threads: {
          list: async () => [],
        },
      },
    });
    await plugin(bb);

    await harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "child-1", parentThreadId: "root" }),
    });

    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "subagents-changed",
      payload: { threadId: "child-1", parentThreadId: "root" },
    });
    await harness.lifecycle.dispose();
  });

  it("uses only public SDK imports", async () => {
    const scan = await experimental_scanPublicSdkOnly(process.cwd(), {
      allow: [
        /^@\//,
        /^@hugeicons\//,
        /^@radix-ui\//,
        /^@testing-library\/react$/,
        /^class-variance-authority$/,
        /^clsx$/,
        /^react(?:-dom)?(?:\/.*)?$/,
        /^tailwind-merge$/,
        /^vitest(?:\/.*)?$/,
      ],
    });
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });
});
