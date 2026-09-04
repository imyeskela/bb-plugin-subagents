import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const executionSchema = z
  .object({
    model: z.string(),
    reasoningLevel: z.string(),
    serviceTier: z.string(),
  })
  .strict();

const messageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["assistant", "user"]),
    text: z.string(),
    createdAt: z.number(),
  })
  .strict();

export const subagentSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["thread", "delegation"]),
    chatThreadId: z.string().nullable(),
    messages: z.array(messageSchema),
    projectId: z.string(),
    parentThreadId: z.string().nullable(),
    relationship: z.enum(["descendant", "delegation"]),
    title: z.string().nullable(),
    titleFallback: z.string().nullable(),
    providerId: z.string(),
    status: z.string(),
    displayStatus: z.string(),
    hasPendingInteraction: z.boolean(),
    visibility: z.enum(["visible", "hidden"]),
    activeBackgroundAgentCount: z.number().int().nonnegative(),
    createdAt: z.number(),
    updatedAt: z.number(),
    execution: executionSchema.nullable(),
  })
  .strict();

export type Subagent = z.infer<typeof subagentSchema>;

export const rpcContract = defineRpcContract({
  subagents_list: {
    input: z.object({ rootThreadId: z.string().min(1) }).strict(),
    output: z
      .object({
        agents: z.array(subagentSchema),
        truncated: z.boolean(),
      })
      .strict(),
  },
});
