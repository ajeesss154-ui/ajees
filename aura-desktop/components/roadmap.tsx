"use client";
import {
  BarChart3,
  BookOpen,
  Boxes,
  GraduationCap,
  Headphones,
  MessageCircle,
  Plane,
  ReceiptText,
  ShoppingBag,
  Sparkles,
} from "lucide-react";
import { PageHeader, StatusPill } from "./ui";
const modules = [
  {
    name: "Learning",
    icon: GraduationCap,
    description:
      "A patient companion for understanding, practicing, and making steady progress.",
    requires: "Study plans, quizzes, practice exercises",
  },
  {
    name: "Shopping",
    icon: ShoppingBag,
    description:
      "Discover thoughtfully, compare clearly, and keep track of the things you care about.",
    requires: "Official merchant data and verified pricing",
  },
  {
    name: "Travel",
    icon: Plane,
    description:
      "From a spark of curiosity to a well-considered itinerary, all in one conversation.",
    requires: "Official travel providers and booking approvals",
  },
  {
    name: "Personal budgeting",
    icon: ReceiptText,
    description:
      "A calmer view of everyday spending. Start simple, with the numbers you choose to share.",
    requires: "Manual expense entry; no financial transactions",
  },
  {
    name: "Data exploration",
    icon: BarChart3,
    description:
      "Find the story in your spreadsheets with verified calculations and clear charts.",
    requires: "CSV import and sandboxed computations",
  },
  {
    name: "Meeting intelligence",
    icon: Headphones,
    description:
      "Bring the conversation into focus. Capture decisions and turn follow-ups into next steps.",
    requires: "User-provided or consented recordings",
  },
  {
    name: "Communication",
    icon: MessageCircle,
    description:
      "The context that matters, across the conversations and teams you choose to connect.",
    requires: "Approved provider APIs and scoped permissions",
  },
  {
    name: "Plugin ecosystem",
    icon: Boxes,
    description:
      "An expanding set of useful capabilities, built on a foundation of clear permissions.",
    requires: "Versioned tools, developer review, explicit scopes",
  },
];
export function RoadmapScreen() {
  return (
    <>
      <PageHeader
        eyebrow="THOUGHTFULLY BUILT, STEADILY GROWING"
        title="More possibilities. One companion."
        description="AURA starts with a working personal workspace. These are the places we’re building toward."
      />
      <div className="roadmap-intro">
        <Sparkles size={24} />
        <p>
          These modules are planned, not connected services. They won’t display
          invented prices, bookings, transactions, or results.
        </p>
        <StatusPill tone="amber">Roadmap</StatusPill>
      </div>
      <div className="roadmap-grid">
        {modules.map((m, i) => (
          <article className="roadmap-card" key={m.name}>
            <div
              className={`stat-icon ${["mint", "sand", "lilac", "peach"][i % 4]}`}
            >
              <m.icon size={22} />
            </div>
            <StatusPill>Planned</StatusPill>
            <h2>{m.name}</h2>
            <p>{m.description}</p>
            <div className="roadmap-requirement">{m.requires}</div>
          </article>
        ))}
      </div>
      <p className="roadmap-footer">
        A clear foundation comes first: useful tools, real data, explicit
        permission, and outcomes you can trust.
      </p>
    </>
  );
}
