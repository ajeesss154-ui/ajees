import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { inflateRawSync } from "node:zlib";
import { db } from "../db";
import { ApiError } from "../http";
import type { SourceReference } from "../contracts";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 500_000;
const MAX_PAGES = 300;
export interface DocumentRecord {
  id: string;
  user_id: string;
  title: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  content?: string;
  created_at: string;
}
type ExtractedPage = { page: number | null; content: string };

/** Check actual decompression, not only attacker-controlled ZIP size fields. */
export function validateOfficeArchive(buffer: Buffer): void {
  const maxExpanded = 20 * 1024 * 1024;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
    if (
      buffer.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + buffer.readUInt16LE(i + 20) === buffer.length
    ) {
      eocd = i;
      break;
    }
  if (eocd < 0)
    throw new ApiError(415, "The Office archive could not be verified.");
  const entries = buffer.readUInt16LE(eocd + 10),
    centralSize = buffer.readUInt32LE(eocd + 12),
    centralStart = buffer.readUInt32LE(eocd + 16);
  if (
    buffer.readUInt16LE(eocd + 4) !== 0 ||
    buffer.readUInt16LE(eocd + 6) !== 0 ||
    entries !== buffer.readUInt16LE(eocd + 8) ||
    entries === 0 ||
    entries > 2000 ||
    centralStart + centralSize !== eocd
  )
    throw new ApiError(415, "Unsupported Office archive structure.");
  let cursor = centralStart,
    totalExpanded = 0;
  const names = new Set<string>();
  for (let count = 0; count < entries; count++) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50)
      throw new ApiError(415, "The Office archive directory is invalid.");
    const flags = buffer.readUInt16LE(cursor + 8),
      method = buffer.readUInt16LE(cursor + 10),
      compressed = buffer.readUInt32LE(cursor + 20),
      uncompressed = buffer.readUInt32LE(cursor + 24),
      nameLength = buffer.readUInt16LE(cursor + 28),
      extraLength = buffer.readUInt16LE(cursor + 30),
      commentLength = buffer.readUInt16LE(cursor + 32),
      local = buffer.readUInt32LE(cursor + 42);
    if (
      cursor + 46 + nameLength + extraLength + commentLength > eocd ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff ||
      uncompressed > maxExpanded - totalExpanded ||
      local + 30 > centralStart
    )
      throw new ApiError(
        413,
        "The Office document exceeds supported archive limits.",
      );
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    if (
      names.has(name) ||
      name.includes("..") ||
      name.startsWith("/") ||
      name.includes("\\")
    )
      throw new ApiError(
        415,
        "The Office archive contains unsupported entries.",
      );
    names.add(name);
    if (
      buffer.readUInt32LE(local) !== 0x04034b50 ||
      buffer.readUInt16LE(local + 8) !== method
    )
      throw new ApiError(415, "The Office archive entry is invalid.");
    const dataStart =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    if (dataStart + compressed > centralStart)
      throw new ApiError(415, "The Office archive entry is truncated.");
    const data = buffer.subarray(dataStart, dataStart + compressed);
    let actual: number;
    try {
      actual =
        method === 0
          ? data.length
          : inflateRawSync(data, {
              maxOutputLength: maxExpanded - totalExpanded + 1,
            }).byteLength;
    } catch {
      throw new ApiError(
        413,
        "The Office document cannot be safely expanded within the upload limit.",
      );
    }
    if (actual !== uncompressed || actual > maxExpanded - totalExpanded)
      throw new ApiError(
        413,
        "The Office document has invalid expansion sizes.",
      );
    totalExpanded += actual;
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (
    cursor !== eocd ||
    !names.has("[Content_Types].xml") ||
    !names.has("word/document.xml")
  )
    throw new ApiError(415, "This archive is not a supported Word document.");
}

/** Files are data, never scripts, trusted instructions, or executable tools. */
export async function extractDocument(
  filename: string,
  mime: string,
  buffer: Buffer,
): Promise<ExtractedPage[]> {
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_UPLOAD_BYTES)
    throw new ApiError(413, "Choose a nonempty document up to 5 MB.");
  const extension = extname(filename).toLowerCase();
  const allowed: Record<string, string[]> = {
    ".txt": ["text/plain"],
    ".md": ["text/markdown", "text/plain", "text/x-markdown"],
    ".pdf": ["application/pdf"],
    ".docx": [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  };
  if (!allowed[extension])
    throw new ApiError(
      415,
      "Supported documents: PDF, TXT, Markdown, and DOCX.",
    );
  if (
    mime &&
    mime !== "application/octet-stream" &&
    !allowed[extension].includes(mime.toLowerCase())
  )
    throw new ApiError(415, "The file type does not match its extension.");
  let pages: ExtractedPage[];
  try {
    if (extension === ".pdf") {
      if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-")
        throw new ApiError(415, "This file is not a valid PDF.");
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const result = await parser.getText({ first: MAX_PAGES + 1 });
        if (result.total > MAX_PAGES)
          throw new ApiError(413, "PDF documents are limited to 300 pages.");
        pages = result.pages.map((p) => ({ page: p.num, content: p.text }));
      } finally {
        await parser.destroy();
      }
    } else if (extension === ".docx") {
      if (
        buffer[0] !== 0x50 ||
        buffer[1] !== 0x4b ||
        buffer[2] !== 0x03 ||
        buffer[3] !== 0x04
      )
        throw new ApiError(415, "This file is not a valid DOCX document.");
      validateOfficeArchive(buffer);
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      pages = [{ page: null, content: result.value }];
    } else {
      if (buffer.includes(0))
        throw new ApiError(
          415,
          "Text documents must contain readable UTF-8 text.",
        );
      const decoder = new TextDecoder("utf-8", { fatal: true });
      pages = [{ page: null, content: decoder.decode(buffer) }];
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      422,
      "Readable text could not be extracted. Password-protected PDFs and scanned images need a text version.",
    );
  }
  const total = pages.reduce((n, p) => n + p.content.length, 0);
  if (total > MAX_TEXT_CHARACTERS)
    throw new ApiError(
      413,
      "The extracted document is too long. Split it into smaller files.",
    );
  pages = pages
    .map((p) => ({ ...p, content: p.content.replace(/\u0000/g, "").trim() }))
    .filter((p) => p.content);
  if (!pages.length)
    throw new ApiError(
      422,
      "This document has no readable text. Scanned images need OCR before uploading.",
    );
  return pages;
}

export function chunkText(
  content: string,
  maxLength = 1600,
  overlap = 180,
): string[] {
  if (maxLength < 100 || overlap < 0 || overlap >= maxLength)
    throw new Error("Invalid chunk size.");
  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(start + maxLength, content.length);
    if (end < content.length) {
      const boundary = content.lastIndexOf(" ", end);
      if (boundary > start + maxLength / 2) end = boundary;
    }
    const chunk = content.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= content.length) break;
    start = end - overlap;
  }
  return chunks;
}

export async function uploadDocument(
  userId: string,
  file: {
    name: string;
    type: string;
    arrayBuffer(): Promise<ArrayBuffer>;
    size: number;
  },
): Promise<DocumentRecord> {
  if (file.size > MAX_UPLOAD_BYTES)
    throw new ApiError(413, "Documents must be 5 MB or smaller.");
  const filename = file.name.replace(/[\x00-\x1f\/\\]/g, "_").slice(0, 200);
  const pages = await extractDocument(
    filename,
    file.type,
    Buffer.from(await file.arrayBuffer()),
  );
  const id = randomUUID();
  const title = filename.replace(/\.[^.]+$/, "") || "Untitled document";
  const content = pages.map((p) => p.content).join("\n\n");
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<DocumentRecord>(
      "INSERT INTO documents(id,user_id,title,filename,mime_type,size_bytes,content) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,user_id,title,filename,mime_type,size_bytes,created_at",
      [
        id,
        userId,
        title,
        filename,
        file.type || "application/octet-stream",
        file.size,
        content,
      ],
    );
    let index = 0;
    for (const page of pages)
      for (const text of chunkText(page.content))
        await tx.query(
          "INSERT INTO document_chunks(id,user_id,document_id,chunk_index,content,page) VALUES($1,$2,$3,$4,$5,$6)",
          [randomUUID(), userId, id, index++, text, page.page],
        );
    await tx.query(
      "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)",
      [
        randomUUID(),
        userId,
        "document.upload",
        "document",
        id,
        JSON.stringify({ filename, size: file.size, chunks: index }),
      ],
    );
    return rows[0];
  });
}

export async function listDocuments(userId: string): Promise<DocumentRecord[]> {
  return (
    await db.query<DocumentRecord>(
      "SELECT id,title,filename,mime_type,size_bytes,created_at FROM documents WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200",
      [userId],
    )
  ).rows;
}
export async function getDocument(
  userId: string,
  id: string,
): Promise<DocumentRecord> {
  const row = (
    await db.query<DocumentRecord>(
      "SELECT id,title,filename,mime_type,size_bytes,content,created_at FROM documents WHERE user_id=$1 AND id=$2",
      [userId, id],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, "Document not found.");
  return row;
}
export async function deleteDocument(
  userId: string,
  id: string,
): Promise<void> {
  const { rows } = await db.query(
    "DELETE FROM documents WHERE user_id=$1 AND id=$2 RETURNING id",
    [userId, id],
  );
  if (!rows.length) throw new ApiError(404, "Document not found.");
  await db.query(
    "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), userId, "document.delete", "document", id],
  );
}

/** PostgreSQL FTS is available locally too: no external vector service is required. */
export async function searchKnowledge(
  userId: string,
  query: string,
): Promise<SourceReference[]> {
  const text = query.trim().slice(0, 500);
  if (!text) return [];
  const like = "%" + text.replace(/[\\%_]/g, "\\$&") + "%";
  const setting = (
    await db.query<{ memory_enabled: boolean }>(
      "SELECT memory_enabled FROM user_settings WHERE user_id=$1",
      [userId],
    )
  ).rows[0];
  const results = await db.query<{
    id: string;
    type: "note" | "document" | "memory";
    title: string;
    content: string;
    page: number | null;
    chunk_index: number | null;
    rank: number;
  }>(
    `
 SELECT * FROM (
 SELECT n.id,'note'::text AS type,n.title,n.content,NULL::integer AS page,NULL::integer AS chunk_index,
 ts_rank(to_tsvector('english',n.title||' '||n.content),plainto_tsquery('english',$2)) AS rank
 FROM notes n WHERE n.user_id=$1 AND (to_tsvector('english',n.title||' '||n.content) @@ plainto_tsquery('english',$2) OR n.title ILIKE $3 OR n.content ILIKE $3)
 UNION ALL
 SELECT d.id,'document',d.title,c.content,c.page,c.chunk_index,
 ts_rank(to_tsvector('english',c.content),plainto_tsquery('english',$2))
 FROM document_chunks c JOIN documents d ON d.id=c.document_id AND d.user_id=c.user_id
 WHERE c.user_id=$1 AND (to_tsvector('english',c.content) @@ plainto_tsquery('english',$2) OR c.content ILIKE $3 OR d.title ILIKE $3)
 UNION ALL
 SELECT m.id,'memory',m.title,m.content,NULL::integer,NULL::integer,
 ts_rank(to_tsvector('english',m.title||' '||m.content),plainto_tsquery('english',$2))
 FROM memories m WHERE m.user_id=$1 AND $4::boolean AND (to_tsvector('english',m.title||' '||m.content) @@ plainto_tsquery('english',$2) OR m.title ILIKE $3 OR m.content ILIKE $3)
 ) hits ORDER BY rank DESC LIMIT 10`,
    [userId, text, like, setting?.memory_enabled === true],
  );
  return results.rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    excerpt: row.content.slice(0, 1800),
    ...(row.type === "document"
      ? {
          location: row.page
            ? `Page ${row.page}`
            : `Section ${(row.chunk_index ?? 0) + 1}`,
        }
      : {}),
  }));
}
