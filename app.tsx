import {
  ThreadChat,
  definePluginApp,
  experimental_useProviders,
  experimental_useSidebarThreadActions,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  JsonValue,
  PluginThreadHeaderActionProps,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { rpcContract, Subagent } from "./contract";

const SUBAGENTS_CHANGED = "subagents-changed";

function useSubagents(rootThreadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  const requestSequence = useRef(0);
  const [agents, setAgents] = useState<Subagent[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const result = await rpc.call("subagents_list", { rootThreadId });
      if (sequence !== requestSequence.current) return;
      setAgents(result.agents);
      setTruncated(result.truncated);
      setError(null);
    } catch (cause) {
      if (sequence !== requestSequence.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rootThreadId, rpc]);

  useEffect(() => {
    void refresh();
    return () => {
      requestSequence.current += 1;
    };
  }, [refresh]);

  useRealtime(SUBAGENTS_CHANGED, () => {
    void refresh();
  });

  useEffect(() => {
    if (connection === "connected" && previousConnection.current === "reconnecting") {
      void refresh();
    }
    previousConnection.current = connection;
  }, [connection, refresh]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refresh();
    }, 3_000);
    return () => window.clearInterval(intervalId);
  }, [refresh]);

  return { agents, truncated, error, refresh };
}

function isRunning(agent: Subagent): boolean {
  return ["active", "pending", "provisioning", "starting", "stopping"].includes(
    agent.displayStatus,
  );
}

function agentName(agent: Subagent): string {
  return agent.title ?? agent.titleFallback ?? "Untitled subagent";
}

function statusLabel(agent: Subagent): string {
  if (agent.hasPendingInteraction) return "Needs input";
  switch (agent.displayStatus) {
    case "active":
      return "Working";
    case "starting":
    case "provisioning":
      return "Starting";
    case "pending":
      return "Pending";
    case "stopping":
      return "Stopping";
    case "error":
      return "Failed";
    case "host-reconnecting":
    case "waiting-for-host":
      return "Waiting for host";
    case "idle":
      return "Idle";
    default:
      return agent.status;
  }
}

function statusDotClass(agent: Subagent): string {
  if (agent.hasPendingInteraction) return "bg-primary";
  if (agent.displayStatus === "error") return "bg-destructive";
  if (isRunning(agent)) return "bg-primary animate-pulse";
  return "bg-muted-foreground/40";
}

function readSelectedThreadId(params: JsonValue | null): string | null {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return null;
  const value = params.selectedThreadId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function orderAgents(agents: readonly Subagent[], rootThreadId: string) {
  const byParent = new Map<string, Subagent[]>();
  for (const agent of agents) {
    const parent = agent.parentThreadId ?? rootThreadId;
    const siblings = byParent.get(parent) ?? [];
    siblings.push(agent);
    byParent.set(parent, siblings);
  }

  const compare = (left: Subagent, right: Subagent) => {
    const runningDelta = Number(isRunning(right)) - Number(isRunning(left));
    return runningDelta || right.updatedAt - left.updatedAt;
  };
  for (const siblings of byParent.values()) siblings.sort(compare);

  const ordered: Array<{ agent: Subagent; depth: number }> = [];
  const seen = new Set<string>();
  const visit = (parentThreadId: string, depth: number) => {
    for (const agent of byParent.get(parentThreadId) ?? []) {
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
      ordered.push({ agent, depth });
      visit(agent.id, depth + 1);
    }
  };
  visit(rootThreadId, 0);
  for (const agent of [...agents].sort(compare)) {
    if (!seen.has(agent.id)) ordered.push({ agent, depth: 0 });
  }
  return ordered;
}

function AgentMeta({
  agent,
  providerName,
}: {
  agent: Subagent;
  providerName: string;
}) {
  const execution = agent.execution;
  return (
    <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
      <span className="truncate">{providerName}</span>
      {execution === null ? null : (
        <>
          <span aria-hidden="true">·</span>
          <span className="truncate">{execution.model}</span>
          <span aria-hidden="true">·</span>
          <span>{execution.reasoningLevel}</span>
        </>
      )}
    </span>
  );
}

function NativeTranscript({ agent }: { agent: Subagent }) {
  return (
    <div className="h-full overflow-y-auto px-3 py-3">
      <p className="mb-3 text-xs text-muted-foreground">
        Read-only native subagent transcript
      </p>
      {agent.messages.length === 0 ? (
        <div className="rounded-md border border-border px-3 py-4 text-center text-sm text-muted-foreground">
          The subagent is working. Its messages will appear here.
        </div>
      ) : (
        <div className="space-y-3">
          {agent.messages.map((message) => (
            <article key={message.id} className="rounded-md border border-border bg-card px-3 py-2.5">
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {message.role === "assistant" ? "Subagent" : "Parent agent"}
              </p>
              <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {message.text}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function SubagentsPanel({ threadId, params }: PluginThreadPanelProps) {
  const { agents, truncated, error, refresh } = useSubagents(threadId);
  const { providers } = experimental_useProviders();
  const threadActions = experimental_useSidebarThreadActions();
  const initialSelection = readSelectedThreadId(params);
  const [selectedThreadId, setSelectedThreadId] = useState(initialSelection);
  const providerNames = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider.displayName])),
    [providers],
  );
  const orderedAgents = useMemo(
    () => orderAgents(agents ?? [], threadId),
    [agents, threadId],
  );

  useEffect(() => {
    if (agents === null) return;
    setSelectedThreadId((current) => {
      if (current !== null && agents.some((agent) => agent.id === current)) return current;
      if (
        initialSelection !== null &&
        agents.some((agent) => agent.id === initialSelection)
      ) {
        return initialSelection;
      }
      return orderedAgents[0]?.agent.id ?? null;
    });
  }, [agents, initialSelection, orderedAgents]);

  const selected = agents?.find((agent) => agent.id === selectedThreadId) ?? null;
  const activeCount = agents?.filter(isRunning).length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <section className="flex max-h-[42%] min-h-32 flex-col border-b border-border">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">Subagents</p>
            <p className="text-xs text-muted-foreground">
              {agents === null
                ? "Loading…"
                : `${activeCount} active · ${agents.length} total`}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            aria-label="Refresh subagents"
            onClick={() => void refresh()}
          >
            <Icon name="RotateCcw" className="size-4" aria-hidden="true" />
          </Button>
        </div>

        {error === null ? null : (
          <div className="border-b border-border px-3 py-2 text-xs text-destructive" role="alert">
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5" role="listbox" aria-label="Subagents">
          {agents === null ? (
            <div className="px-2 py-4 text-center text-sm text-muted-foreground">
              Loading subagents…
            </div>
          ) : orderedAgents.length === 0 ? (
            <div className="px-2 py-4 text-center text-sm text-muted-foreground">
              No active subagents in this chat.
            </div>
          ) : (
            orderedAgents.map(({ agent, depth }) => {
              const selectedRow = selectedThreadId === agent.id;
              const providerName = providerNames.get(agent.providerId) ?? agent.providerId;
              return (
                <button
                  key={agent.id}
                  type="button"
                  role="option"
                  aria-selected={selectedRow}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md py-2 pr-2 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    selectedRow && "bg-state-active",
                  )}
                  style={{ paddingLeft: `${8 + Math.min(depth, 4) * 14}px` }}
                  onClick={() => setSelectedThreadId(agent.id)}
                >
                  <span
                    className={cn("mt-1.5 size-2 shrink-0 rounded-full", statusDotClass(agent))}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{agentName(agent)}</span>
                      {agent.kind === "thread" && agent.visibility === "hidden" ? (
                        <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
                          hidden
                        </span>
                      ) : null}
                      {agent.relationship === "delegation" ? (
                        <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
                          native
                        </span>
                      ) : null}
                    </span>
                    <AgentMeta agent={agent} providerName={providerName} />
                  </span>
                  <span className="shrink-0 pt-0.5 text-[10px] text-muted-foreground">
                    {statusLabel(agent)}
                  </span>
                </button>
              );
            })
          )}
          {truncated ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              Showing the first 100 subagents.
            </p>
          ) : null}
        </div>
      </section>

      <section className="flex min-h-0 flex-1 flex-col">
        {selected === null ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
            Select a subagent to open its chat.
          </div>
        ) : (
          <>
            <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
              <span className={cn("size-2 shrink-0 rounded-full", statusDotClass(selected))} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{agentName(selected)}</p>
                <AgentMeta
                  agent={selected}
                  providerName={providerNames.get(selected.providerId) ?? selected.providerId}
                />
              </div>
              {selected.chatThreadId === null ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground"
                  aria-label={`Open ${agentName(selected)} in split view`}
                  onClick={() => threadActions.open(selected.chatThreadId!, { split: true })}
                >
                  <Icon name="NewTab" className="size-4" aria-hidden="true" />
                </Button>
              )}
            </div>
            <div className="min-h-0 flex-1">
              {selected.kind === "delegation" ? (
                <NativeTranscript agent={selected} />
              ) : selected.chatThreadId === null ? null : (
                <ThreadChat
                  key={selected.chatThreadId}
                  threadId={selected.chatThreadId}
                  variant="compact"
                  layout="contained"
                  permissionPolicy="inherit"
                  className="h-full"
                />
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function SubagentsHeaderAction({ threadId }: PluginThreadHeaderActionProps) {
  const { agents } = useSubagents(threadId);
  const navigate = useBbNavigate();
  const activeCount = agents?.filter(isRunning).length ?? 0;
  const totalCount = agents?.length ?? 0;
  const label = `Subagents: ${activeCount} active, ${totalCount} total`;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="relative size-7 text-muted-foreground"
      aria-label={label}
      onClick={() => {
        navigate.openThreadPanel({ actionId: "subagents" });
      }}
    >
      <Icon name="Bot" className="size-4" aria-hidden="true" />
      {activeCount > 0 ? (
        <span className="absolute -right-1 -top-1 min-w-3.5 rounded-full bg-primary px-1 text-[9px] font-semibold leading-3.5 text-primary-foreground">
          {activeCount > 99 ? "99+" : activeCount}
        </span>
      ) : null}
    </Button>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "subagents",
    title: "Subagents",
    icon: "Bot",
    component: SubagentsPanel,
    layout: "flush",
  });

  app.slots.experimental_threadHeaderAction({
    id: "subagents",
    title: "Subagents",
    component: SubagentsHeaderAction,
  });
});
