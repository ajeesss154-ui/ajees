import { z } from "zod";
import { requireUser } from "../../../../../lib/auth";
import { api, readJson } from "../../../../../lib/http";
import {
  beginGoogleConnection,
  providerSchema,
} from "../../../../../lib/connectors/google";
type Context = { params: Promise<{ provider: string }> };
export const POST = api<Context>(async (request, context) => {
  const user = await requireUser(request);
  const provider = providerSchema.parse((await context.params).provider);
  const data = await readJson(
    request,
    z.object({ allowWrites: z.boolean().default(false) }).strict(),
  );
  return Response.json({
    url: await beginGoogleConnection(user.id, provider, data.allowWrites),
  });
});
