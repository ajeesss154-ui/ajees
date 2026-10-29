"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ArrowUpRight,
  Check,
  CheckSquare2,
  Clock3,
  FolderPlus,
  Layers3,
  Plus,
  Search,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import {
  EmptyState,
  ErrorBanner,
  errorMessage,
  formatDate,
  dateInput,
  Modal,
  PageHeader,
  RecordData,
  request,
  Spinner,
  StatusPill,
  useResource,
} from "./ui";
function matchesTaskView(item: RecordData, view: string) {
  if (view === "all") return true;
  if (view === "done") return item.status === "done";
  if (item.status === "done") return false;
  if (view === "overdue")
    return (
      Boolean(item.due_at) &&
      new Date(String(item.due_at)).getTime() < Date.now()
    );
  if (view === "upcoming")
    return (
      Boolean(item.due_at) &&
      new Date(String(item.due_at)).getTime() >= Date.now()
    );
  return true;
}
export function ResourceScreen({ kind }: { kind: "notes" | "tasks" }) {
  const notes = kind === "notes",
    params = useSearchParams(),
    { data, error, loading, reload } = useResource<{ items: RecordData[] }>(
      `/api/${kind}`,
    ),
    projects = useResource<{ items: RecordData[] }>("/api/projects");
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [project, setProject] = useState(""),
    [editing, setEditing] = useState<RecordData | null | undefined>(undefined),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [newProject, setNewProject] = useState(false);
  useEffect(() => {
    if (params.get("new") === "1") setEditing(null);
  }, [params]);
  useEffect(() => {
    if (params.get("note") && data)
      setEditing(data.items.find((n) => n.id === params.get("note")));
  }, [params, data]);
  const items = (data?.items ?? []).filter(
    (r) =>
      (!project || r.project_id === project) &&
      `${r.title} ${r.content ?? r.body ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (notes || matchesTaskView(r, filter)),
  );
  async function remove(id: string) {
    if (
      !confirm(`Delete this ${notes ? "note" : "task"}? This cannot be undone.`)
    )
      return;
    setBusy(true);
    try {
      await request(`/api/${kind}/${id}`, { method: "DELETE" });
      setEditing(undefined);
      await reload();
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function toggleTask(item: RecordData) {
    try {
      await request(`/api/tasks/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: item.status === "done" ? "todo" : "done",
        }),
      });
      await reload();
    } catch (e) {
      setMessage(errorMessage(e));
    }
  }
  return (
    <>
      <PageHeader
        eyebrow={notes ? "THINK IT. KEEP IT." : "A LITTLE PROGRESS, EVERY DAY"}
        title={notes ? "Notes & ideas" : "Tasks & projects"}
        description={
          notes
            ? "A home for the thoughts worth keeping. AURA can help connect them."
            : "Give your plans a next step. Keep the bigger picture in view."
        }
        action={
          <button
            className="button primary"
            onClick={() => {
              setMessage("");
              setEditing(null);
            }}
          >
            <Plus size={16} />
            {notes ? "New note" : "New task"}
          </button>
        }
      />
      <ErrorBanner message={error || message} />
      <div className="resource-toolbar">
        <div className="search-field">
          <Search size={17} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={notes ? "Search your notes…" : "Search tasks…"}
            aria-label={notes ? "Search notes" : "Search tasks"}
          />
        </div>
        <select
          value={project}
          onChange={(e) => setProject(e.target.value)}
          aria-label="Filter by project"
        >
          <option value="">All projects</option>
          {projects.data?.items.map((p) => (
            <option value={p.id} key={p.id}>
              {String(p.name)}
            </option>
          ))}
        </select>
        <button
          className="button secondary"
          onClick={() => setNewProject(true)}
        >
          <FolderPlus size={16} />
          <span>New project</span>
        </button>
      </div>
      {!notes && (
        <div className="tabs" aria-label="Task view">
          {[
            { id: "all", label: "All tasks" },
            { id: "active", label: "Active" },
            { id: "upcoming", label: "Upcoming" },
            { id: "overdue", label: "Overdue" },
            { id: "done", label: "Completed" },
          ].map((f) => (
            <button
              key={f.id}
              className={filter === f.id ? "selected" : ""}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              <span>
                {
                  (data?.items ?? []).filter((r) => matchesTaskView(r, f.id))
                    .length
                }
              </span>
            </button>
          ))}
        </div>
      )}
      {loading ? (
        <div className="panel panel-loading">
          <Spinner />
        </div>
      ) : items.length ? (
        notes ? (
          <div className="notes-grid">
            {items.map((item, i) => (
              <button
                key={item.id}
                className={`note-card note-tone-${i % 3}`}
                onClick={() => setEditing(item)}
              >
                <div className="note-card-top">
                  <StickyNote size={18} strokeWidth={1.4} />
                  <ArrowUpRight size={16} />
                </div>
                <h2>{String(item.title)}</h2>
                <p>
                  {String(item.content ?? "").slice(0, 250) ||
                    "No content yet."}
                </p>
                <div className="note-card-footer">
                  <span>{formatDate(item.updated_at ?? item.created_at)}</span>
                  {item.project_id ? (
                    <span className="pill">
                      {String(
                        projects.data?.items.find(
                          (p) => p.id === item.project_id,
                        )?.name ?? "Project",
                      )}
                    </span>
                  ) : null}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="panel task-table">
            <div className="task-table-head">
              <span>Task</span>
              <span>Priority</span>
              <span>Due date</span>
              <span>Project</span>
              <span />
            </div>
            {items.map((item) => (
              <div
                key={item.id}
                className={`task-row ${item.status === "done" ? "done" : ""}`}
              >
                <button
                  className="task-check"
                  onClick={() => void toggleTask(item)}
                  aria-label={
                    item.status === "done"
                      ? `Reopen ${item.title}`
                      : `Complete ${item.title}`
                  }
                >
                  {item.status === "done" && <Check size={14} />}
                </button>
                <button
                  className="task-description"
                  onClick={() => setEditing(item)}
                >
                  <strong>{String(item.title)}</strong>
                  {item.body ? (
                    <small>{String(item.body).slice(0, 90)}</small>
                  ) : null}
                </button>
                <span
                  className={`priority-label priority-${String(item.priority)}`}
                >
                  <span />
                  {String(item.priority ?? "medium")}
                </span>
                <span
                  className={
                    item.status !== "done" &&
                    item.due_at &&
                    new Date(String(item.due_at)) < new Date()
                      ? "overdue-date"
                      : ""
                  }
                >
                  {item.due_at ? formatDate(item.due_at) : "—"}
                </span>
                <span className="task-project">
                  {String(
                    projects.data?.items.find((p) => p.id === item.project_id)
                      ?.name ?? "Personal",
                  )}
                </span>
                <button
                  className="icon-button"
                  aria-label={`Delete ${item.title}`}
                  onClick={() => void remove(item.id)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="panel">
          <EmptyState
            icon={notes ? StickyNote : CheckSquare2}
            title={
              query || project
                ? "Nothing matches yet"
                : notes
                  ? "Every good idea starts somewhere."
                  : "Your next chapter, one task at a time."
            }
            description={
              query || project
                ? "Try another search or change the project filter."
                : notes
                  ? "Capture a thought, a meeting, a half-formed idea. You can always shape it later."
                  : "Add a task to get moving, or ask AURA to turn a note into a plan."
            }
            action={
              <button
                className="button secondary"
                onClick={() => setEditing(null)}
              >
                <Plus size={16} />
                {notes ? "Write a note" : "Add your first task"}
              </button>
            }
          />
        </div>
      )}
      {projects.data?.items.length ? (
        <section className="projects-strip">
          <div className="section-heading">
            <h2>Your projects</h2>
            <span className="muted">Bring your work together</span>
          </div>
          <div className="project-mini-grid">
            {projects.data.items.map((p) => (
              <div key={p.id} className="project-mini">
                <button
                  className="project-open"
                  onClick={() => setProject(project === p.id ? "" : p.id)}
                >
                  <Layers3 size={18} />
                  <strong>{String(p.name)}</strong>
                  <span>
                    {
                      (data?.items ?? []).filter((x) => x.project_id === p.id)
                        .length
                    }{" "}
                    {kind}
                  </span>
                </button>
                <button
                  className="icon-button"
                  aria-label={`Delete project ${p.name}`}
                  onClick={async () => {
                    if (
                      confirm(
                        "Delete this project? Its notes and tasks will be ungrouped.",
                      )
                    ) {
                      try {
                        await request(`/api/projects/${p.id}`, {
                          method: "DELETE",
                        });
                        await projects.reload();
                        setProject("");
                        await reload();
                      } catch (e) {
                        setMessage(errorMessage(e));
                      }
                    }
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {editing !== undefined && (
        <Modal
          title={
            editing
              ? notes
                ? "Edit note"
                : "Edit task"
              : notes
                ? "A new thought"
                : "A new next step"
          }
          onClose={() => setEditing(undefined)}
          wide={notes}
        >
          <ErrorBanner message={message} />
          <form
            className="edit-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setMessage("");
              const f = new FormData(e.currentTarget);
              const payload = notes
                ? {
                    title: f.get("title"),
                    content: f.get("content"),
                    project_id: f.get("project_id") || null,
                    tags: String(f.get("tags") ?? "")
                      .split(",")
                      .map((t) => t.trim())
                      .filter(Boolean),
                  }
                : {
                    title: f.get("title"),
                    body: f.get("body"),
                    priority: f.get("priority"),
                    status: f.get("status"),
                    due_at: f.get("due_at")
                      ? new Date(String(f.get("due_at"))).toISOString()
                      : null,
                    remind_at: f.get("remind_at")
                      ? new Date(String(f.get("remind_at"))).toISOString()
                      : null,
                    project_id: f.get("project_id") || null,
                  };
              try {
                await request(
                  `/api/${kind}${editing ? `/${editing.id}` : ""}`,
                  {
                    method: editing ? "PATCH" : "POST",
                    body: JSON.stringify(payload),
                  },
                );
                setEditing(undefined);
                await reload();
              } catch (err) {
                setMessage(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              {notes ? "Title" : "What needs to get done?"}
              <input
                name="title"
                placeholder={
                  notes ? "An idea worth keeping" : "A small, clear next step"
                }
                defaultValue={String(editing?.title ?? "")}
                maxLength={200}
                required
                autoFocus
              />
            </label>
            <label>
              {notes ? "Your note" : "Details"}
              <textarea
                name={notes ? "content" : "body"}
                defaultValue={String(
                  (notes ? editing?.content : editing?.body) ?? "",
                )}
                rows={notes ? 10 : 3}
                maxLength={notes ? 100000 : 10000}
                placeholder={
                  notes
                    ? "Start anywhere. The blank page is yours…"
                    : "A little context goes a long way…"
                }
              />
            </label>
            {!notes && (
              <div className="form-grid">
                <label>
                  Priority
                  <select
                    name="priority"
                    defaultValue={String(editing?.priority ?? "medium")}
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </label>
                <label>
                  Status
                  <select
                    name="status"
                    defaultValue={String(editing?.status ?? "todo")}
                  >
                    <option value="todo">To do</option>
                    <option value="in_progress">In progress</option>
                    <option value="done">Complete</option>
                  </select>
                </label>
                <label>
                  Due date
                  <input
                    type="datetime-local"
                    name="due_at"
                    defaultValue={dateInput(editing?.due_at)}
                  />
                </label>
                <label>
                  Remind me
                  <input
                    type="datetime-local"
                    name="remind_at"
                    defaultValue={dateInput(editing?.remind_at)}
                  />
                </label>
              </div>
            )}
            <div className="form-grid">
              <label>
                Project
                <select
                  name="project_id"
                  defaultValue={String(editing?.project_id ?? "")}
                >
                  <option value="">Personal / no project</option>
                  {projects.data?.items.map((p) => (
                    <option key={p.id} value={p.id}>
                      {String(p.name)}
                    </option>
                  ))}
                </select>
              </label>
              {notes && (
                <label>
                  Tags, separated by commas
                  <input
                    name="tags"
                    defaultValue={
                      Array.isArray(editing?.tags)
                        ? editing.tags.join(", ")
                        : ""
                    }
                    placeholder="ideas, work, learning"
                  />
                </label>
              )}
            </div>
            {!notes && (
              <p className="form-help">
                <Clock3 size={13} /> Reminders are delivered in AURA while the
                app or worker is running. Browser alerts need notification
                permission.
              </p>
            )}
            <div className="modal-actions">
              {editing && (
                <button
                  type="button"
                  className="button danger ghost"
                  disabled={busy}
                  onClick={() => void remove(editing.id)}
                >
                  <Trash2 size={15} /> Delete
                </button>
              )}
              {editing && notes && (
                <Link
                  className="button secondary"
                  href={`/assistant?prompt=${encodeURIComponent(`Find my note titled "${editing.title}" and summarize it, then propose action items as tasks for my review.`)}`}
                >
                  <SparklesIcon /> Ask AURA
                </Link>
              )}
              <span />
              <button
                className="button secondary"
                type="button"
                onClick={() => setEditing(undefined)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? <Spinner /> : <Check size={15} />}Save{" "}
                {notes ? "note" : "task"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {newProject && (
        <Modal title="A new project" onClose={() => setNewProject(false)}>
          <ErrorBanner message={message} />
          <form
            className="edit-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const f = new FormData(e.currentTarget);
              try {
                await request("/api/projects", {
                  method: "POST",
                  body: JSON.stringify({
                    name: f.get("name"),
                    description: f.get("description"),
                  }),
                });
                setNewProject(false);
                await projects.reload();
              } catch (err) {
                setMessage(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Project name
              <input name="name" required maxLength={200} autoFocus />
            </label>
            <label>
              What’s the goal?
              <textarea name="description" rows={3} />
            </label>
            <div className="modal-actions">
              <button className="button primary" disabled={busy}>
                Create project <ArrowUpRight size={15} />
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
function SparklesIcon() {
  return <span aria-hidden="true">✧</span>;
}
