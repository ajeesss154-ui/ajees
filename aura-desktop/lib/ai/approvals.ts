import { randomUUID } from "node:crypto";
import { db, type QueryClient } from "../db";
import type { ToolContext } from "../contracts";
import { ApiError } from "../http";
import { audit } from "../services/workspace";
import { AssistantError } from "./provider";
import {
  executeTool,
  getTool,
  validateToolInput,
  userRequestedWrite,
} from "./tools";

export type Approval = {
  id: string;
  user_id: string;
  conversation_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  status: string;
  expires_at: string | Date;
  result: unknown;
  created_at: string | Date;
};
export function safeActionError(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : "The action could not be completed. Check the workspace or connected provider before trying a new request.";
}
export async function createApproval(
  ctx: ToolContext,
  name: string,
  input: unknown,
  userRequest: string,
): Promise<Approval> {
  const tool = getTool(name);
  if (!tool.confirmation)
    throw new AssistantError(400, "Read-only tools do not need approval.");
  if (!userRequestedWrite(userRequest))
    throw new AssistantError(
      403,
      "A write action needs an explicit request from you, followed by review and approval.",
      "write_not_requested",
    );
  const args = validateToolInput(name, input);
  return db.transaction(async (tx) => {
    const conversation = (
      await tx.query(
        "SELECT id FROM conversations WHERE id=$1 AND user_id=$2",
        [ctx.conversationId, ctx.userId],
      )
    ).rows[0];
    if (!conversation) throw new AssistantError(404, "Conversation not found.");
    const active = (
      await tx.query<{ count: string }>(
        "SELECT count(*)::text count FROM approval_requests WHERE user_id=$1 AND conversation_id=$2 AND status=$3 AND expires_at>now()",
        [ctx.userId, ctx.conversationId, "pending"],
      )
    ).rows[0];
    if (Number(active?.count || 0) >= 24)
      throw new AssistantError(
        429,
        "Review your pending actions before proposing more.",
      );
    const row = (
      await tx.query<Approval>(
        "INSERT INTO approval_requests(id,user_id,conversation_id,tool_name,input,status,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,'pending',now()+interval '15 minutes') RETURNING *",
        [
          randomUUID(),
          ctx.userId,
          ctx.conversationId,
          name,
          JSON.stringify(args),
        ],
      )
    ).rows[0];
    await audit(
      ctx.userId,
      "approval_proposed",
      "approval_requests",
      row.id,
      { tool: name },
      tx,
    );
    return row;
  });
}
export async function recordToolExecution(
  ctx: ToolContext,
  name: string,
  input: unknown,
  output: unknown,
  status: "completed" | "failed",
  error?: string,
  client: QueryClient = db,
) {
  await client.query(
    "INSERT INTO tool_executions(id,user_id,conversation_id,tool_name,input,output,status,error) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)",
    [
      randomUUID(),
      ctx.userId,
      ctx.conversationId,
      name,
      JSON.stringify(input),
      JSON.stringify(output ?? null),
      status,
      error || null,
    ],
  );
  await audit(
    ctx.userId,
    status === "completed" ? "tool_completed" : "tool_failed",
    "tool_executions",
    null,
    { tool: name },
    client,
  );
}
async function appendOutcome(
  tx: QueryClient,
  approval: Approval,
  result: unknown,
  error?: string,
) {
  const content = error
    ? `Action failed: ${approval.tool_name.replaceAll("_", " ")}. ${error}`
    : `Approved action completed: ${approval.tool_name.replaceAll("_", " ")}. The backend confirmed success.`;
  await tx.query(
    "INSERT INTO messages(id,user_id,conversation_id,role,content) VALUES($1,$2,$3,'assistant',$4)",
    [randomUUID(), approval.user_id, approval.conversation_id, content],
  );
  await tx.query(
    "UPDATE conversations SET updated_at=now() WHERE id=$1 AND user_id=$2",
    [approval.conversation_id, approval.user_id],
  );
  await tx.query(
    "UPDATE approval_requests SET status=$1,result=$2::jsonb WHERE id=$3 AND user_id=$4",
    [
      error ? "failed" : "completed",
      JSON.stringify(error ? { error } : result),
      approval.id,
      approval.user_id,
    ],
  );
  await recordToolExecution(
    { userId: approval.user_id, conversationId: approval.conversation_id },
    approval.tool_name,
    approval.input,
    result,
    error ? "failed" : "completed",
    error,
    tx,
  );
  await audit(
    approval.user_id,
    error ? "approval_failed" : "approval_completed",
    "approval_requests",
    approval.id,
    { tool: approval.tool_name },
    tx,
  );
}
export async function decideApproval(
  userId: string,
  id: string,
  decision: "approve" | "reject",
): Promise<{ approval: Approval; result: unknown }> {
  let reserved: Approval | undefined;
  let local = false;
  try {
    const first = await db.transaction(async (tx) => {
      const row = (
        await tx.query<Approval>(
          "SELECT * FROM approval_requests WHERE id=$1 AND user_id=$2 FOR UPDATE",
          [id, userId],
        )
      ).rows[0];
      if (!row) throw new AssistantError(404, "Approval not found.");
      if (row.status !== "pending")
        throw new AssistantError(
          409,
          `This action is already ${row.status}. It cannot execute again.`,
          "approval_used",
        );
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await tx.query(
          "UPDATE approval_requests SET status='expired' WHERE id=$1 AND user_id=$2",
          [id, userId],
        );
        return { expired: true };
      }
      if (decision === "reject") {
        await tx.query(
          "UPDATE approval_requests SET status='rejected' WHERE id=$1 AND user_id=$2",
          [id, userId],
        );
        await audit(
          userId,
          "approval_rejected",
          "approval_requests",
          id,
          { tool: row.tool_name },
          tx,
        );
        return { approval: { ...row, status: "rejected" }, result: null };
      }
      const tool = getTool(row.tool_name);
      if (!tool.confirmation)
        throw new AssistantError(
          400,
          "This approval is not a registered write action.",
        );
      validateToolInput(row.tool_name, row.input);
      await tx.query(
        "UPDATE approval_requests SET status='executing' WHERE id=$1 AND user_id=$2",
        [id, userId],
      );
      reserved = { ...row, status: "executing" };
      if (tool.external) return { external: true };
      local = true;
      const result = await executeTool(
        {
          userId,
          conversationId: row.conversation_id,
          approvalId: id,
          client: tx,
        },
        row.tool_name,
        row.input,
      );
      await appendOutcome(tx, row, result);
      return { approval: { ...row, status: "completed", result }, result };
    });
    if ("expired" in first)
      throw new AssistantError(
        409,
        "This proposal expired. Ask AURA to propose it again.",
        "approval_expired",
      );
    if ("approval" in first && first.approval)
      return { approval: first.approval, result: first.result };
    if (!reserved)
      throw new AssistantError(500, "The action could not be reserved.");
    const row: Approval = reserved;
    // External APIs cannot share a database transaction. Commit the one-use reservation first.
    // A process crash leaves 'executing'; the application never automatically retries it.
    const result = await executeTool(
      { userId, conversationId: row.conversation_id, approvalId: id },
      row.tool_name,
      row.input,
    );
    await db.transaction((tx) => appendOutcome(tx, row, result));
    return { approval: { ...row, status: "completed", result }, result };
  } catch (error) {
    if (reserved) {
      const row: Approval = reserved;
      const message = safeActionError(error);
      // Local failures roll the entire write back; external failures are not retried.
      await db.transaction(async (tx) => {
        const state = (
          await tx.query<{ status: string }>(
            "SELECT status FROM approval_requests WHERE id=$1 AND user_id=$2 FOR UPDATE",
            [id, userId],
          )
        ).rows[0];
        if (state && state.status === (local ? "pending" : "executing"))
          await appendOutcome(tx, row, null, message);
      });
    }
    throw error;
  }
}
