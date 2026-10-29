import { z } from "zod";
import { requireUser } from "../../../../lib/auth";
import { api } from "../../../../lib/http";
import { calendarListEvents } from "../../../../lib/connectors/google";
export const GET = api(async (request) => {
  const user = await requireUser(request);
  const params = new URL(request.url).searchParams;
  const input = z
    .object({
      query: z.string().max(500).optional(),
      timeMin: z.iso.datetime({ offset: true }).optional(),
      timeMax: z.iso.datetime({ offset: true }).optional(),
    })
    .parse(
      Object.fromEntries(
        ["query", "timeMin", "timeMax"]
          .filter((k) => params.has(k))
          .map((k) => [k, params.get(k)]),
      ),
    );
  return Response.json(await calendarListEvents(user.id, input));
});
