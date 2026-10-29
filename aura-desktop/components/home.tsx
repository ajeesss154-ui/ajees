"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  BookOpen,
  CalendarDays,
  Check,
  CheckSquare2,
  Circle,
  Clock3,
  FileText,
  Layers3,
  Plus,
  Sparkles,
  StickyNote,
  WandSparkles,
} from "lucide-react";
import { useSession } from "./shell";
import {
  ArrowLink,
  EmptyState,
  ErrorBanner,
  formatDate,
  PageHeader,
  RecordData,
  SectionTitle,
  Spinner,
  StatusPill,
  useResource,
} from "./ui";
type Dashboard = {
  tasks: RecordData[];
  reminders: RecordData[];
  notes: RecordData[];
  conversations: RecordData[];
  projects: RecordData[];
  stats: {
    total_tasks: number;
    completed_tasks: number;
    overdue_tasks: number;
    due_today: number;
    total_notes: number;
    total_projects: number;
    pending_reminders: number;
  };
  integrations: RecordData[];
  suggestions: unknown[];
};
export function HomeScreen() {
  const user = useSession(),
    router = useRouter(),
    { data, error, loading } = useResource<Dashboard>("/api/dashboard"),
    [prompt, setPrompt] = useState("");
  const date = new Date();
  const time =
    date.getHours() < 12
      ? "morning"
      : date.getHours() < 17
        ? "afternoon"
        : "evening";
  return (
    <div className="home-page">
      <PageHeader
        eyebrow={date
          .toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
          })
          .toUpperCase()}
        title={`Good ${time}, ${user?.name.split(" ")[0] ?? "there"}.`}
        description="Make room for what matters. AURA will help with the rest."
        action={
          <Link className="button secondary" href="/tasks?new=1">
            <Plus size={16} /> Create task
          </Link>
        }
      />
      <ErrorBanner message={error} />
      <section className="assistant-hero">
        <div className="hero-copy">
          <div className="hero-label">
            <span className="status-dot" /> YOUR INTELLIGENT COMPANION
          </div>
          <h2>
            A clear head.
            <br />A capable companion.
          </h2>
          <p>
            Connect the dots between your ideas, knowledge,
            <br className="desktop-break" /> and the things you want to get
            done.
          </p>
          <form
            className="hero-prompt"
            onSubmit={(e) => {
              e.preventDefault();
              if (prompt.trim())
                router.push(
                  `/assistant?prompt=${encodeURIComponent(prompt.trim())}`,
                );
            }}
          >
            <Sparkles size={18} />
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What’s on your mind?"
              aria-label="What would you like help with?"
            />
            <button aria-label="Open assistant">
              <ArrowRight size={19} />
            </button>
          </form>
          <div className="hero-suggestions">
            {["Plan my day", "Find a note", "What should I focus on?"].map(
              (p) => (
                <Link
                  href={`/assistant?prompt=${encodeURIComponent(p)}`}
                  key={p}
                >
                  {p}
                  <ArrowUpRight size={12} />
                </Link>
              ),
            )}
          </div>
        </div>
        <div className="aura-visual" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="orbit orbit-three" />
          <div className="orbit-axis" />
          <div className="aura-core">
            <div />
            <Sparkles size={38} strokeWidth={0.8} />
          </div>
          <span className="orbit-point p1" />
          <span className="orbit-point p2" />
          <span className="orbit-point p3" />
          <div className="visual-caption">
            A LITTLE INTELLIGENCE. A LOT OF POSSIBILITY.
          </div>
        </div>
      </section>
      <div className="stat-grid">
        {[
          {
            label: "Tasks in motion",
            value: data
              ? data.stats.total_tasks - data.stats.completed_tasks
              : "—",
            icon: CheckSquare2,
            note: data
              ? `${data.stats.due_today} due today`
              : "Your next steps, together",
            tone: "mint",
          },
          {
            label: "Ideas captured",
            value: data?.stats.total_notes ?? "—",
            icon: StickyNote,
            note: "Room for every thought",
            tone: "sand",
          },
          {
            label: "Projects growing",
            value: data?.stats.total_projects ?? "—",
            icon: Layers3,
            note: "Small steps, bigger picture",
            tone: "lilac",
          },
          {
            label: "Upcoming reminders",
            value: data?.stats.pending_reminders ?? "—",
            icon: Clock3,
            note: "A gentle nudge, on time",
            tone: "peach",
          },
        ].map((s) => (
          <div className="stat-card" key={s.label}>
            <div className="stat-top">
              <span>{s.label}</span>
              <span className={`stat-icon ${s.tone}`}>
                <s.icon size={17} />
              </span>
            </div>
            <strong>{s.value}</strong>
            <p>{s.note}</p>
          </div>
        ))}
      </div>
      <div className="home-grid">
        <section className="panel today-panel">
          <SectionTitle
            title="Your next steps"
            aside={<ArrowLink href="/tasks">All tasks</ArrowLink>}
          />
          {loading ? (
            <div className="panel-loading">
              <Spinner />
            </div>
          ) : data?.tasks.length ? (
            <div className="task-preview-list">
              {data.tasks.slice(0, 5).map((task) => (
                <Link href="/tasks" className="task-preview" key={task.id}>
                  <span
                    className={`task-circle ${task.status === "done" ? "checked" : ""}`}
                  >
                    {task.status === "done" ? <Check size={13} /> : null}
                  </span>
                  <div>
                    <strong>{String(task.title)}</strong>
                    <p>
                      {task.project_name
                        ? String(task.project_name)
                        : "Personal"}
                      {task.due_at ? ` · ${formatDate(task.due_at)}` : ""}
                    </p>
                  </div>
                  <StatusPill
                    tone={task.priority === "high" ? "amber" : "neutral"}
                  >
                    {String(task.priority ?? "medium")}
                  </StatusPill>
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={CheckSquare2}
              title="A fresh start for your day"
              description="Add your first task, or ask AURA to help you make a plan."
              action={
                <Link href="/tasks?new=1" className="button secondary small">
                  <Plus size={14} /> Add a task
                </Link>
              }
            />
          )}
        </section>
        <section className="panel notes-panel">
          <SectionTitle
            title="Recent thoughts"
            aside={<ArrowLink href="/notes">All notes</ArrowLink>}
          />
          {loading ? (
            <div className="panel-loading">
              <Spinner />
            </div>
          ) : data?.notes.length ? (
            <div className="recent-notes">
              {data.notes.slice(0, 3).map((n) => (
                <Link
                  key={n.id}
                  href={`/notes?note=${n.id}`}
                  className="recent-note"
                >
                  <span className="note-marker">
                    <StickyNote size={17} />
                  </span>
                  <div>
                    <h3>{String(n.title)}</h3>
                    <p>
                      {String(n.content ?? "").slice(0, 90) ||
                        "An idea waiting to unfold."}
                    </p>
                    <small>{formatDate(n.updated_at ?? n.created_at)}</small>
                  </div>
                  <ArrowUpRight size={15} />
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={StickyNote}
              title="Give your thoughts a home"
              description="Capture an idea, a meeting note, or something you don’t want to lose."
              action={
                <Link href="/notes?new=1" className="text-link">
                  Write your first note <ArrowRight size={14} />
                </Link>
              }
            />
          )}
        </section>
        <section className="panel projects-panel">
          <SectionTitle
            title="The bigger picture"
            aside={<ArrowLink href="/tasks">Projects</ArrowLink>}
          />
          {data?.projects.length ? (
            <div className="project-progress-list">
              {data.projects.slice(0, 3).map((p, i) => {
                const total = Number(p.total_tasks ?? 0),
                  complete = Number(p.completed_tasks ?? 0);
                return (
                  <div key={p.id} className="project-progress">
                    <div>
                      <span className={`project-dot color-${i % 3}`} />
                      <strong>{String(p.name)}</strong>
                      <small>
                        {complete}/{total} tasks
                      </small>
                    </div>
                    <progress
                      max={Math.max(total, 1)}
                      value={complete}
                      aria-label={`${String(p.name)} progress`}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="compact-empty">
              <Layers3 size={24} strokeWidth={1.4} />
              <p>Bring related tasks and notes together in a project.</p>
              <Link href="/tasks" className="text-link">
                Create a project <ArrowUpRight size={13} />
              </Link>
            </div>
          )}
        </section>
        <section className="panel momentum-panel">
          <div className="momentum-icon">
            <WandSparkles size={22} />
          </div>
          <div>
            <h2>A little momentum goes a long way.</h2>
            <p>
              Turn a rough note into a clear set of next steps. AURA proposes,
              you decide.
            </p>
            <Link
              href="/assistant?prompt=Help%20me%20turn%20one%20of%20my%20notes%20into%20tasks"
              className="text-link"
            >
              Think it through with AURA <ArrowRight size={14} />
            </Link>
          </div>
        </section>
      </div>
      <div className="home-grid home-context-grid">
        <section className="panel">
          <SectionTitle
            title="A gentle nudge, ahead"
            aside={<ArrowLink href="/tasks">Reminders</ArrowLink>}
          />
          {data?.reminders.length ? (
            <div className="home-reminders">
              {data.reminders.map((r) => (
                <Link key={r.id} href="/tasks">
                  <Clock3 size={15} />
                  <div>
                    <strong>{String(r.title)}</strong>
                    <small>{formatDate(r.scheduled_at, true)} · In-app</small>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="home-context-empty">
              No upcoming reminders. Add a reminder time to a task when you’d
              like a nudge.
            </p>
          )}
        </section>
        <section className="panel">
          <SectionTitle
            title="Pick up a conversation"
            aside={<ArrowLink href="/assistant">Assistant</ArrowLink>}
          />
          {data?.conversations.length ? (
            <div className="home-conversations">
              {data.conversations.slice(0, 3).map((c) => (
                <Link key={c.id} href={`/assistant?conversation=${c.id}`}>
                  <AudioLines size={15} />
                  <div>
                    <strong>{String(c.title)}</strong>
                    <small>{formatDate(c.updated_at ?? c.created_at)}</small>
                  </div>
                  <ArrowUpRight size={13} />
                </Link>
              ))}
            </div>
          ) : (
            <p className="home-context-empty">
              Every conversation starts somewhere. Bring a thought to AURA and
              build from there.
            </p>
          )}
        </section>
      </div>
      <section className="home-connection-strip">
        <span>YOUR CONNECTED CONTEXT</span>
        {[
          { provider: "google_calendar", name: "Calendar", icon: CalendarDays },
          { provider: "gmail", name: "Gmail", icon: FileText },
        ].map((c) => {
          const connected = data?.integrations.some(
            (i) => i.provider === c.provider && i.status === "connected",
          );
          return (
            <Link key={c.provider} href="/connections">
              <c.icon size={13} />
              {c.name}
              <span
                className={`connection-dot ${connected ? "connected" : ""}`}
              />
              <small>{connected ? "Connected" : "Not connected"}</small>
            </Link>
          );
        })}
      </section>
      {data?.suggestions.length ? (
        <div className="home-suggestions">
          <span>
            <Sparkles size={13} /> A LITTLE NEXT-STEP INSPIRATION
          </span>
          {data.suggestions.slice(0, 3).map((s, i) => (
            <Link
              href={`/assistant?prompt=${encodeURIComponent(String(s))}`}
              key={i}
            >
              {String(s)}
              <ArrowRight size={12} />
            </Link>
          ))}
        </div>
      ) : null}
      <div className="home-bottom">
        <span>
          <span className="status-dot" /> Everything here comes from your
          workspace.
        </span>
        <Link href="/connections">
          Connect your calendar & email <ArrowUpRight size={13} />
        </Link>
      </div>
    </div>
  );
}
