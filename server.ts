import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract, type Subagent } from "./contract.js";

const SUBAGENTS_CHANGED = "subagents-changed";
const MAX_SUBAGENTS = 100;
const MAX_NATIVE_SUBAGENTS = 100;
const MAX_NATIVE_MESSAGES = 50;
const MAX_MESSAGE_LENGTH = 12_000;

type ThreadListItem = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["list"]>
>[number];
type ThreadTimelineResult = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["timeline"]>
>;
type TimelineRow = ThreadTimelineResult["rows"][number];
type DelegationRow = Extract<
  TimelineRow,
  { kind: "work"; workKind: "delegation" }
>;

async function readDescendants(
  bb: BbPluginApi,
  rootThreadId: string,
): Promise<{ rows: ThreadListItem[]; truncated: boolean }> {
  const rows: ThreadListItem[] = [];
  const parents = [rootThreadId];
  let truncated = false;

  while (parents.length > 0 && rows.length < MAX_SUBAGENTS) {
    const parentThreadId = parents.shift();
    if (parentThreadId === undefined) break;

    const remaining = MAX_SUBAGENTS - rows.length;
    const children = await bb.sdk.threads.list({
      parentThreadId,
      includeHidden: true,
      archived: false,
      limit: remaining + 1,
    });
    const accepted = children.slice(0, remaining);

    rows.push(...accepted);
    parents.push(...accepted.map((thread) => thread.id));
    if (children.length > remaining) {
      truncated = true;
      break;
    }
  }

  if (parents.length > 0 && rows.length >= MAX_SUBAGENTS) truncated = true;
  return { rows, truncated };
}

async function readExecution(
  bb: BbPluginApi,
  threadId: string,
): Promise<Subagent["execution"]> {
  try {
    const resolved = await bb.sdk.threads.defaultExecutionOptions({
      threadId,
    });
    if (resolved !== null) {
      return {
        model: resolved.model,
        reasoningLevel: resolved.reasoningLevel,
        serviceTier: resolved.serviceTier,
      };
    }
  } catch (cause) {
    bb.log.debug(
      `Could not resolve execution options for ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return null;
}

async function enrichThreadSubagent(
  bb: BbPluginApi,
  thread: ThreadListItem,
): Promise<Subagent> {
  const execution = await readExecution(bb, thread.id);

  return {
    id: thread.id,
    kind: "thread",
    chatThreadId: thread.id,
    messages: [],
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    relationship: "descendant",
    title: thread.title,
    titleFallback: thread.titleFallback,
    providerId: thread.providerId,
    status: thread.status,
    displayStatus: thread.runtime.displayStatus,
    hasPendingInteraction: thread.hasPendingInteraction,
    visibility: thread.visibility,
    activeBackgroundAgentCount: thread.activity.activeBackgroundAgentCount,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    execution,
  };
}

function visitRows(
  rows: readonly TimelineRow[],
  visitor: (row: TimelineRow) => void,
): void {
  for (const row of rows) {
    visitor(row);
    if (row.kind === "turn" && row.children !== null) {
      visitRows(row.children, visitor);
    } else if (row.kind === "work" && row.workKind === "delegation") {
      visitRows(row.childRows, visitor);
    }
  }
}

function readMessages(row: DelegationRow): Subagent["messages"] {
  const messages = new Map<string, Subagent["messages"][number]>();
  const visitConversationRows = (rows: readonly TimelineRow[]) => {
    for (const child of rows) {
      if (child.kind === "conversation" && child.text.trim().length > 0) {
        messages.set(child.id, {
          id: child.id,
          role: child.role,
          text: child.text.slice(0, MAX_MESSAGE_LENGTH),
          createdAt: child.createdAt,
        });
      } else if (child.kind === "turn" && child.children !== null) {
        visitConversationRows(child.children);
      }
    }
  };
  visitConversationRows(row.childRows);
  return [...messages.values()]
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-MAX_NATIVE_MESSAGES);
}

function delegationTitle(row: DelegationRow): string {
  const raw =
    row.description ??
    row.subagentType ??
    (row.childRef === null ? "Subagent" : `Subagent ${row.childRef.slice(-8)}`);
  return raw.replace(/^\/root\//, "").replaceAll("_", " ");
}

async function readNativeSubagents(
  bb: BbPluginApi,
  rootThreadId: string,
): Promise<{ agents: Subagent[]; truncated: boolean }> {
  let timeline: ThreadTimelineResult;
  try {
    timeline = await bb.sdk.threads.timeline({
      threadId: rootThreadId,
      includeNestedRows: "true",
      segmentLimit: "100",
    });
  } catch (cause) {
    bb.log.debug(
      `Could not read timeline for ${rootThreadId}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return { agents: [], truncated: false };
  }

  const byId = new Map<string, DelegationRow>();
  visitRows(timeline.rows, (row) => {
    if (row.kind !== "work" || row.workKind !== "delegation") return;
    const previous = byId.get(row.id);
    const rowIsTerminal = row.status !== "pending";
    const previousIsTerminal = previous !== undefined && previous.status !== "pending";
    if (
      previous === undefined ||
      (rowIsTerminal && !previousIsTerminal) ||
      (rowIsTerminal === previousIsTerminal && row.sourceSeqEnd >= previous.sourceSeqEnd)
    ) {
      byId.set(row.id, row);
    }
  });

  const active = [...byId.values()]
    .filter((row) => row.status === "pending")
    .sort((left, right) => right.startedAt - left.startedAt);
  if (active.length === 0) return { agents: [], truncated: false };

  const [root, execution] = await Promise.all([
    bb.sdk.threads.get({ threadId: rootThreadId }),
    readExecution(bb, rootThreadId),
  ]);
  const agents = active.slice(0, MAX_NATIVE_SUBAGENTS).map((row): Subagent => {
    const messages = readMessages(row);
    const updatedAt = Math.max(
      row.startedAt,
      ...messages.map((message) => message.createdAt),
    );
    return {
      id: row.id,
      kind: "delegation",
      chatThreadId: null,
      messages,
      projectId: root.projectId,
      parentThreadId: rootThreadId,
      relationship: "delegation",
      title: delegationTitle(row),
      titleFallback: row.subagentType,
      providerId: root.providerId,
      status: row.status,
      displayStatus: "active",
      hasPendingInteraction: false,
      visibility: "hidden",
      activeBackgroundAgentCount: 0,
      createdAt: row.startedAt,
      updatedAt,
      execution,
    };
  });
  return {
    agents,
    truncated: active.length > MAX_NATIVE_SUBAGENTS,
  };
}

export default function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    subagents_list: async ({ rootThreadId }) => {
      const [descendants, native] = await Promise.all([
        readDescendants(bb, rootThreadId),
        readNativeSubagents(bb, rootThreadId),
      ]);
      const agents = await Promise.all([
        ...native.agents,
        ...descendants.rows.map((thread) => enrichThreadSubagent(bb, thread)),
      ]);
      return {
        agents,
        truncated: descendants.truncated || native.truncated,
      };
    },
  });

  const announceChange = ({
    thread,
  }: {
    thread: { id: string; parentThreadId: string | null };
  }) => {
    bb.realtime.publish(SUBAGENTS_CHANGED, {
      threadId: thread.id,
      parentThreadId: thread.parentThreadId,
    });
  };

  bb.events.on("thread.created", announceChange);
  bb.events.on("thread.active", announceChange);
  bb.events.on("thread.idle", announceChange);
  bb.events.on("thread.failed", announceChange);
  bb.events.on("thread.archived", announceChange);
  bb.events.on("thread.deleted", announceChange);
}
