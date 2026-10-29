import { requireUser } from "@/lib/auth";
import { api } from "@/lib/http";
import { providerStatus } from "@/lib/ai/provider";
export const runtime = "nodejs";
export const GET = api(async (request: Request) => {
  await requireUser(request);
  return Response.json(providerStatus());
});
