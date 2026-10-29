import { requireUser, rateLimit } from "@/lib/auth";
import { api, readJson } from "@/lib/http";
import { chatInputSchema, prepareTurn, runTurn } from "@/lib/ai/engine";
import { assertProviderConfigured } from "@/lib/ai/provider";
export const runtime = "nodejs";
export const maxDuration = 300;
export const POST = api(async (request: Request) => {
  const user = await requireUser(request);
  await rateLimit(`chat:${user.id}`, 30, 60);
  const input = await readJson(request, chatInputSchema);
  assertProviderConfigured();
  const turn = await prepareTurn(user.id, input);
  const encoder = new TextEncoder();
  const cancellation = new AbortController();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (
        event: Parameters<typeof runTurn>[1] extends (event: infer E) => void
          ? E
          : never,
      ) => {
        if (!closed) {
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
          } catch {
            closed = true;
          }
        }
      };
      void runTurn(turn, emit, {
        signal: AbortSignal.any([request.signal, cancellation.signal]),
      })
        .catch(() =>
          emit({
            type: "error",
            message: "The conversation could not finish. Please try again.",
          }),
        )
        .finally(() => {
          if (!closed) {
            closed = true;
            controller.close();
          }
        });
    },
    cancel() {
      closed = true;
      cancellation.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
