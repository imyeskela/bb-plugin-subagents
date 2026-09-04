// @vitest-environment jsdom

import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Subagent } from "../contract";

function subagent(id: string, overrides: Partial<Subagent> = {}): Subagent {
  return {
    id,
    kind: "thread",
    chatThreadId: id,
    messages: [],
    projectId: "project-1",
    parentThreadId: "root",
    relationship: "descendant",
    title: id,
    titleFallback: null,
    providerId: "codex",
    status: "idle",
    displayStatus: "idle",
    hasPendingInteraction: false,
    visibility: "visible",
    activeBackgroundAgentCount: 0,
    createdAt: 1,
    updatedAt: 1,
    execution: {
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: "default",
    },
    ...overrides,
  };
}

describe("Subagents app", () => {
  it("registers a right-panel tab and a thread-header action", async () => {
    const app = await loadPluginApp(() => import("../app"));

    expect(app.threadPanelActions).toEqual([
      expect.objectContaining({ id: "subagents", title: "Subagents", layout: "flush" }),
    ]);
    expect(app.threadHeaderActions).toEqual([
      expect.objectContaining({ id: "subagents", title: "Subagents" }),
    ]);
  });

  it("renders a native subagent transcript without opening another thread", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const native = subagent("delegation-1", {
      kind: "delegation",
      chatThreadId: null,
      relationship: "delegation",
      title: "check api",
      status: "pending",
      displayStatus: "active",
      execution: null,
      messages: [
        {
          id: "message-1",
          role: "assistant",
          text: "Checking the API now.",
          createdAt: 2,
        },
      ],
    });
    const panel = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "root", params: null },
      {
        rpc: {
          subagents_list: () => ({ agents: [native], truncated: false }),
        },
      },
    );

    expect(await panel.findByText("Checking the API now.")).toBeTruthy();
    expect(panel.queryByTestId("bb-thread-chat")).toBeNull();
    expect(panel.getByText("Read-only native subagent transcript")).toBeTruthy();
    expect(panel.queryByText("Model and reasoning unavailable")).toBeNull();
    expect(panel.queryByText("gpt-5.6-sol")).toBeNull();
    expect(panel.queryByText("high")).toBeNull();
    panel.lifecycle.unmount();
  });

  it("selects an agent and renders its native compact chat", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const child = subagent("child-1", {
      title: "Research API",
      status: "active",
      displayStatus: "active",
      updatedAt: 2,
    });
    const nested = subagent("child-2", {
      parentThreadId: "child-1",
      title: "Check tests",
      execution: null,
    });
    const panel = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "root", params: null },
      {
        rpc: {
          subagents_list: () => ({ agents: [child, nested], truncated: false }),
        },
      },
    );

    expect(await panel.findByText("Research API")).toBeTruthy();
    expect(panel.getAllByText("gpt-5.6-sol").length).toBeGreaterThanOrEqual(1);
    await waitFor(() => {
      expect(panel.getByTestId("bb-thread-chat").getAttribute("data-thread-id")).toBe(
        "child-1",
      );
    });

    fireEvent.click(panel.getByRole("option", { name: /Check tests/i }));
    await waitFor(() => {
      expect(panel.getByTestId("bb-thread-chat").getAttribute("data-thread-id")).toBe(
        "child-2",
      );
    });
    panel.lifecycle.unmount();
  });

  it("groups native subagents under their parent with an indent and counts all three", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const native = (id: string, overrides: Partial<Subagent> = {}) =>
      subagent(id, {
        kind: "delegation",
        chatThreadId: null,
        relationship: "delegation",
        status: "pending",
        displayStatus: "active",
        ...overrides,
      });
    const panel = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "root", params: null },
      {
        rpc: {
          subagents_list: () => ({
            agents: [
              native("ssrf sandbox review", { parentThreadId: "backend review", updatedAt: 3 }),
              native("frontend review", { updatedAt: 2 }),
              native("backend review"),
            ],
            truncated: false,
          }),
        },
      },
    );

    expect(await panel.findByText("3 active · 3 total")).toBeTruthy();
    const rows = panel.getAllByRole("option");
    expect(rows.map((row) => row.textContent?.split("native")[0])).toEqual([
      "frontend review", "backend review", "ssrf sandbox review",
    ]);
    expect(rows[0]!.style.paddingLeft).toBe(rows[1]!.style.paddingLeft);
    expect(parseInt(rows[2]!.style.paddingLeft)).toBeGreaterThan(
      parseInt(rows[1]!.style.paddingLeft),
    );
    fireEvent.click(rows[2]!);
    expect(rows[2]!.getAttribute("aria-selected")).toBe("true");
    panel.lifecycle.unmount();
  });

  it("opens the panel from the header and shows the active count", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const header = renderSlot(
      app.threadHeaderActions[0]!,
      { threadId: "root", projectId: "project-1", isCompactViewport: false },
      {
        rpc: {
          subagents_list: () => ({
            agents: [subagent("child-1", { status: "active", displayStatus: "active" })],
            truncated: false,
          }),
        },
        openThreadPanel: () => true,
      },
    );

    const button = await header.findByRole("button", {
      name: "Subagents: 1 active, 1 total",
    });
    fireEvent.click(button);
    expect(header.inspection.navigateCalls).toContainEqual({
      method: "openThreadPanel",
      options: { actionId: "subagents" },
    });
    header.lifecycle.unmount();
  });
});
