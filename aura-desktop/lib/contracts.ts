export type EntityKind = "notes" | "tasks" | "projects" | "memories";
export type User = { id: string; email: string; name: string };
export type SourceReference = {
  id: string;
  type: "note" | "document" | "memory";
  title: string;
  excerpt: string;
  location?: string;
};
export type ChatEvent = {
  type: "status" | "delta" | "sources" | "approval" | "done" | "error";
  [key: string]: unknown;
};
export type ToolContext = { userId: string; conversationId: string };
