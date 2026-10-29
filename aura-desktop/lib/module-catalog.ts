/** Versioned extension boundary. Catalog entries are roadmap, never connected services. */
export type ModuleState = "roadmap" | "available";
export type CapabilityPermission =
  | "notes:read"
  | "notes:write"
  | "tasks:read"
  | "tasks:write"
  | "documents:read"
  | "calendar:read"
  | "calendar:write"
  | "mail:read"
  | "mail:send";
export interface CapabilityManifest {
  apiVersion: "1";
  id: string;
  name: string;
  description: string;
  permissions: readonly CapabilityPermission[];
  state: ModuleState;
  requiresConfirmation: boolean;
}
export const roadmapModules: readonly CapabilityManifest[] = [
  {
    apiVersion: "1",
    id: "learning",
    name: "Learning",
    description:
      "Study plans, practice exercises and quizzes grounded in your material.",
    permissions: ["documents:read", "notes:read"],
    state: "roadmap",
    requiresConfirmation: false,
  },
  {
    apiVersion: "1",
    id: "shopping",
    name: "Shopping",
    description:
      "Wishlists and comparisons from verified merchant APIs. No purchase execution.",
    permissions: [],
    state: "roadmap",
    requiresConfirmation: true,
  },
  {
    apiVersion: "1",
    id: "travel",
    name: "Travel",
    description:
      "Itinerary planning through official providers; booking always requires review.",
    permissions: ["calendar:read"],
    state: "roadmap",
    requiresConfirmation: true,
  },
  {
    apiVersion: "1",
    id: "budget",
    name: "Personal budgeting",
    description:
      "Private manual expenses, categories and goals. No bank transfers.",
    permissions: [],
    state: "roadmap",
    requiresConfirmation: true,
  },
  {
    apiVersion: "1",
    id: "data",
    name: "Data analysis",
    description:
      "CSV imports and verified statistics with reproducible charts.",
    permissions: ["documents:read"],
    state: "roadmap",
    requiresConfirmation: false,
  },
  {
    apiVersion: "1",
    id: "meetings",
    name: "Meetings",
    description:
      "Consented recording transcription, summaries and proposed follow-ups.",
    permissions: ["notes:write", "tasks:write"],
    state: "roadmap",
    requiresConfirmation: true,
  },
  {
    apiVersion: "1",
    id: "communication",
    name: "Communication hub",
    description: "Explicitly approved collaboration and messaging connectors.",
    permissions: ["mail:read", "mail:send"],
    state: "roadmap",
    requiresConfirmation: true,
  },
  {
    apiVersion: "1",
    id: "marketplace",
    name: "Plugin marketplace",
    description:
      "Reviewed, signed capability manifests with scoped permissions and versioned APIs.",
    permissions: [],
    state: "roadmap",
    requiresConfirmation: true,
  },
];
