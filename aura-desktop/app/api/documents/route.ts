import { requireUser } from "../../../lib/auth";
import { api, ApiError } from "../../../lib/http";
import {
  listDocuments,
  uploadDocument,
  MAX_UPLOAD_BYTES,
} from "../../../lib/services/knowledge";
export const runtime = "nodejs";
export const GET = api(async (request) => {
  const user = await requireUser(request);
  return Response.json({ items: await listDocuments(user.id) });
});
export const POST = api(async (request) => {
  const user = await requireUser(request);
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.startsWith("multipart/form-data;"))
    throw new ApiError(415, "Upload the file as a multipart form.");
  const limit = MAX_UPLOAD_BYTES + 64 * 1024;
  if (Number(request.headers.get("content-length") || 0) > limit)
    throw new ApiError(413, "Documents must be 5 MB or smaller.");
  if (!request.body) throw new ApiError(400, "Select a file to upload.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new ApiError(413, "Documents must be 5 MB or smaller.");
    }
    chunks.push(value);
  }
  const form = await new Response(Buffer.concat(chunks), {
    headers: { "content-type": contentType },
  }).formData();
  const file = form.get("file");
  if (!(file instanceof File))
    throw new ApiError(400, "Select a file to upload.");
  return Response.json(
    { item: await uploadDocument(user.id, file) },
    { status: 201 },
  );
});
