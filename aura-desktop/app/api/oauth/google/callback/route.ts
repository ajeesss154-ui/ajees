import { requireUser } from "../../../../../lib/auth";
import { api, ApiError } from "../../../../../lib/http";
import { completeGoogleConnection } from "../../../../../lib/connectors/google";
export const GET = api(async (request) => {
  const user = await requireUser(request);
  const url = new URL(request.url);
  if (url.searchParams.has("error"))
    throw new ApiError(
      400,
      "Google connection was cancelled or denied. Return to Connections to try again.",
    );
  const provider = await completeGoogleConnection(
    user.id,
    url.searchParams.get("state") || "",
    url.searchParams.get("code") || "",
  );
  return Response.redirect(
    new URL("/connections?connected=" + provider, request.url),
    303,
  );
});
