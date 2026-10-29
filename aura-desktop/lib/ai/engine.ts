import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db";
import type { ChatEvent, SourceReference, ToolContext } from "../contracts";
import { ApiError } from "../http";
import { getSettings } from "../services/workspace";
import {
  AIProvider,
  AssistantError,
  assertProviderConfigured,
  type ProviderMessage,
} from "./provider";
import {
  createApproval,
  recordToolExecution,
  safeActionError,
} from "./approvals";
import {
  executeTool,
  functionDefinitions,
  getTool,
  sourcesFromResult,
  stableJSON,
  validateToolInput,
} from "./tools";

export const chatInputSchema = z
  .object({
    message: z.string().trim().min(1).max(12000),
    conversationId: z.string().uuid().optional(),
  })
  .strict();
export type Conversation = {
  id: string;
  user_id: string;
  title: string;
  created_at: string | Date;
  updated_at: string | Date;
};
export type Message = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  sources: SourceReference[];
  created_at: string | Date;
};
export type PreparedTurn = {
  ctx: ToolContext;
  messages: ProviderMessage[];
  request: string;
  timezone: string;
  memoryEnabled: boolean;
};
export async function listConversations(
  userId: string,
): Promise<Conversation[]> {
  return (
    await db.query<Conversation>(
      "SELECT id,title,created_at,updated_at FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100",
      [userId],
    )
  ).rows;
}
export async function getConversation(userId: string, id: string) {
  if (!z.string().uuid().safeParse(id).success)
    throw new AssistantError(400, "A valid conversation ID is required.");
  const conversation = (
    await db.query<Conversation>(
      "SELECT * FROM conversations WHERE user_id=$1 AND id=$2",
      [userId, id],
    )
  ).rows[0];
  if (!conversation) throw new AssistantError(404, "Conversation not found.");
  await db.query(
    "UPDATE approval_requests SET status='expired' WHERE user_id=$1 AND conversation_id=$2 AND status='pending' AND expires_at<=now()",
    [userId, id],
  );
  const [messages, approvals] = await Promise.all([
    db.query<Message>(
      "SELECT id,role,content,sources,created_at FROM messages WHERE user_id=$1 AND conversation_id=$2 ORDER BY created_at,id LIMIT 500",
      [userId, id],
    ),
    db.query(
      "SELECT id,tool_name,input,status,expires_at,result,created_at FROM approval_requests WHERE user_id=$1 AND conversation_id=$2 ORDER BY created_at,id",
      [userId, id],
    ),
  ]);
  return { conversation, messages: messages.rows, approvals: approvals.rows };
}
export async function deleteConversation(userId: string, id: string) {
  if (!z.string().uuid().safeParse(id).success)
    throw new AssistantError(400, "A valid conversation ID is required.");
  const result = await db.query(
    "DELETE FROM conversations WHERE id=$1 AND user_id=$2 RETURNING id",
    [id, userId],
  );
  if (!result.rows.length)
    throw new AssistantError(404, "Conversation not found.");
  return { ok: true };
}
export async function prepareTurn(
  userId: string,
  input: z.infer<typeof chatInputSchema>,
): Promise<PreparedTurn> {
  const settings = await getSettings(userId);
  return db.transaction(async (tx) => {
    let conversationId = input.conversationId;
    if (conversationId) {
      const row = (
        await tx.query(
          "SELECT id FROM conversations WHERE id=$1 AND user_id=$2 FOR UPDATE",
          [conversationId, userId],
        )
      ).rows[0];
      if (!row) throw new AssistantError(404, "Conversation not found.");
    } else {
      conversationId = randomUUID();
      await tx.query(
        "INSERT INTO conversations(id,user_id,title) VALUES($1,$2,$3)",
        [conversationId, userId, input.message.slice(0, 90)],
      );
    }
    await tx.query(
      "INSERT INTO messages(id,user_id,conversation_id,role,content) VALUES($1,$2,$3,'user',$4)",
      [randomUUID(), userId, conversationId, input.message],
    );
    await tx.query(
      "UPDATE conversations SET updated_at=now() WHERE id=$1 AND user_id=$2",
      [conversationId, userId],
    );
    const history = (
      await tx.query<Message>(
        "SELECT role,content,created_at FROM messages WHERE user_id=$1 AND conversation_id=$2 AND role IN ('user','assistant') ORDER BY created_at DESC,id DESC LIMIT 24",
        [userId, conversationId],
      )
    ).rows.reverse();
    let total = 0;
    const messages = history
      .reverse()
      .filter((m) => {
        total += m.content.length;
        return total <= 60000;
      })
      .reverse()
      .map((m) => ({
        role:
          m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: m.content,
      }));
    return {
      ctx: { userId, conversationId },
      messages,
      request: input.message,
      timezone: String(settings.timezone || "UTC"),
      memoryEnabled: Boolean(settings.memory_enabled),
    };
  });
}
export type EngineOptions = { provider?: AIProvider; signal?: AbortSignal };
export async function runTurn(
  turn: PreparedTurn,
  emit: (event: ChatEvent) => void,
  options: EngineOptions = {},
): Promise<void> {
  assertProviderConfigured();
  const provider = options.provider || new AIProvider();
  const results: {
    tool: string;
    input: unknown;
    result?: unknown;
    error?: string;
    approval?: unknown;
  }[] = [];
  const sources: SourceReference[] = [];
  const seen = new Set<string>();
  let callsCount = 0;
  let answer = "";
  const reference = () => ({
    server_now: new Date().toISOString(),
    user_timezone: turn.timezone,
    long_term_memory_enabled: turn.memoryEnabled,
    tool_results: results,
    sources,
  });
  const status = (message: string) =>
    emit({ type: "status", message, conversationId: turn.ctx.conversationId });
  status("Understanding your request");
  try {
    for (let round = 0; round < 4 && callsCount < 8; round++) {
      if (options.signal?.aborted)
        throw new AssistantError(499, "Conversation stopped.");
      const calls = await provider.plan(
        turn.messages,
        functionDefinitions(),
        reference(),
        options.signal,
      );
      if (!calls.length) break;
      let fresh = 0;
      for (const call of calls) {
        if (options.signal?.aborted)
          throw new AssistantError(499, "Conversation stopped.");
        if (callsCount >= 8) break;
        const key = stableJSON(call);
        if (seen.has(key)) continue;
        seen.add(key);
        fresh++;
        callsCount++;
        try {
          const tool = getTool(call.name);
          const input = validateToolInput(call.name, call.input);
          if (tool.confirmation) {
            status(
              `Preparing ${tool.name.replaceAll("_", " ")} for your review`,
            );
            const approval = await createApproval(
              turn.ctx,
              tool.name,
              input,
              turn.request,
            );
            results.push({
              tool: tool.name,
              input,
              approval: {
                id: approval.id,
                status: "pending",
                message:
                  "Proposed only; no action executed. The user must review and approve the exact inputs.",
              },
            });
            emit({ type: "approval", approval });
          } else {
            status(`Using ${tool.name.replaceAll("_", " ")}`);
            const result = await executeTool(turn.ctx, tool.name, input);
            await recordToolExecution(
              turn.ctx,
              tool.name,
              input,
              result,
              "completed",
            );
            results.push({ tool: tool.name, input, result });
            for (const ref of sourcesFromResult(tool.name, result)) {
              if (
                !sources.some(
                  (s) =>
                    s.type === ref.type &&
                    s.id === ref.id &&
                    s.location === ref.location,
                )
              )
                sources.push(ref);
            }
            if (sources.length) emit({ type: "sources", sources });
          }
        } catch (error) {
          const message = safeActionError(error);
          results.push({ tool: call.name, input: call.input, error: message });
          await recordToolExecution(
            turn.ctx,
            call.name,
            call.input,
            null,
            "failed",
            message,
          );
          status(message);
        }
      }
      if (!fresh || results.some((r) => r.approval)) break;
    }
    status("Writing your response");
    answer = await provider.streamAnswer(
      turn.messages,
      reference(),
      (text) => {
        answer += text;
        emit({ type: "delta", text });
      },
      options.signal,
    );
    const messageId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO messages(id,user_id,conversation_id,role,content,sources) VALUES($1,$2,$3,'assistant',$4,$5::jsonb)",
        [
          messageId,
          turn.ctx.userId,
          turn.ctx.conversationId,
          answer,
          JSON.stringify(sources),
        ],
      );
      await tx.query(
        "UPDATE conversations SET updated_at=now() WHERE id=$1 AND user_id=$2",
        [turn.ctx.conversationId, turn.ctx.userId],
      );
    });
    emit({ type: "done", conversationId: turn.ctx.conversationId, messageId });
  } catch (error) {
    const message = safeActionError(error);
    // Persist an interruption marker rather than treating partial text as a finished answer.
    const content = answer
      ? `${answer}\n\n[Response interrupted: ${message}]`
      : `AURA could not complete this response: ${message}`;
    await db
      .query(
        "INSERT INTO messages(id,user_id,conversation_id,role,content,sources) VALUES($1,$2,$3,'assistant',$4,$5::jsonb)",
        [
          randomUUID(),
          turn.ctx.userId,
          turn.ctx.conversationId,
          content,
          JSON.stringify(sources),
        ],
      )
      .catch(() => undefined);
    emit({
      type: "error",
      message,
      code: error instanceof ApiError ? error.code : "assistant_error",
      conversationId: turn.ctx.conversationId,
    });
  }
}
