"use client";
import { useEffect, useState } from "react";
import {
  Bell,
  Brain,
  Check,
  ChevronRight,
  Cpu,
  Eye,
  FileClock,
  Fingerprint,
  LockKeyhole,
  Moon,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  Volume2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { applyTheme } from "./theme";
import {
  ErrorBanner,
  errorMessage,
  formatDate,
  Modal,
  PageHeader,
  RecordData,
  request,
  Spinner,
  StatusPill,
  useResource,
} from "./ui";
type Settings = {
  memory_enabled: boolean;
  theme: string;
  timezone: string;
  notifications_enabled: boolean;
};
export function SettingsScreen() {
  const { data, error, loading, reload } = useResource<{
      settings: Settings;
      user: { id: string; name: string; email: string };
    }>("/api/settings"),
    memories = useResource<{ items: RecordData[] }>("/api/memories"),
    audit = useResource<{ items: RecordData[] }>("/api/audit"),
    status = useResource<{
      provider: string;
      model: string;
      configured: boolean;
      database: string;
    }>("/api/ai/status");
  const [message, setMessage] = useState(""),
    [success, setSuccess] = useState(""),
    [editing, setEditing] = useState<RecordData | null | undefined>(undefined),
    [deleting, setDeleting] = useState(false),
    [busy, setBusy] = useState(false),
    [notificationState, setNotificationState] = useState("unknown");
  const router = useRouter();
  useEffect(
    () =>
      setNotificationState(
        "Notification" in window ? Notification.permission : "unsupported",
      ),
    [],
  );
  async function save(patch: Partial<Settings>) {
    setMessage("");
    setSuccess("");
    try {
      await request("/api/settings", {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      await reload();
      setSuccess("Your preferences are saved.");
      if (patch.theme) {
        applyTheme(patch.theme);
      }
    } catch (e) {
      setMessage(errorMessage(e));
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="MAKE YOURSELF AT HOME"
        title="Your workspace. Your rules."
        description="Shape how AURA works with you, what it remembers, and what it can access."
      />
      <ErrorBanner message={error || message} />
      {success && (
        <div role="status" className="success-banner">
          <Check size={16} />
          {success}
        </div>
      )}
      {loading ? (
        <Spinner />
      ) : (
        <div className="settings-grid">
          <div className="settings-primary">
            <section className="panel settings-panel">
              <div className="settings-title">
                <Fingerprint size={20} />
                <div>
                  <h2>Your account</h2>
                  <p>A space that belongs to you.</p>
                </div>
              </div>
              <div className="account-summary">
                <div className="large-avatar">
                  {data?.user.name.slice(0, 1).toUpperCase()}
                </div>
                <div>
                  <strong>{data?.user.name}</strong>
                  <p>{data?.user.email}</p>
                </div>
                <StatusPill tone="green">Personal workspace</StatusPill>
              </div>
            </section>
            <section className="panel settings-panel">
              <div className="settings-title">
                <Brain size={20} />
                <div>
                  <h2>A little context, on your terms.</h2>
                  <p>Saved memory is separate from your conversations.</p>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <strong>Use long-term memory</strong>
                  <p>
                    Let AURA retrieve facts and preferences you explicitly save.
                    Turning this off keeps your memories, but stops AI
                    retrieval.
                  </p>
                </div>
                <button
                  className={`toggle ${data?.settings.memory_enabled ? "on" : ""}`}
                  role="switch"
                  aria-checked={Boolean(data?.settings.memory_enabled)}
                  aria-label="Use long-term memory"
                  onClick={() =>
                    void save({
                      memory_enabled: !data?.settings.memory_enabled,
                    })
                  }
                >
                  <span />
                </button>
              </div>
              <div className="memory-section-heading">
                <span>{memories.data?.items.length ?? 0} saved memories</span>
                <button className="text-link" onClick={() => setEditing(null)}>
                  <Plus size={14} /> Add memory
                </button>
              </div>
              {memories.error ? (
                <ErrorBanner message={memories.error} />
              ) : memories.data?.items.length ? (
                <div className="memory-list">
                  {memories.data.items.map((m) => (
                    <div className="memory-item" key={m.id}>
                      <div>
                        <span className="memory-kind">{String(m.kind)}</span>
                        <strong>{String(m.title)}</strong>
                        <p>{String(m.content)}</p>
                      </div>
                      <button
                        className="icon-button"
                        aria-label={`Edit memory ${m.title}`}
                        onClick={() => setEditing(m)}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Delete memory ${m.title}`}
                        onClick={async () => {
                          if (confirm("Delete this saved memory?")) {
                            try {
                              await request(`/api/memories/${m.id}`, {
                                method: "DELETE",
                              });
                              await memories.reload();
                            } catch (e) {
                              setMessage(errorMessage(e));
                            }
                          }
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="memory-empty">
                  <Brain size={23} />
                  <p>
                    No saved memories yet. Add a preference, a goal, or
                    something you’d like AURA to know.
                  </p>
                </div>
              )}
            </section>
            <section className="panel settings-panel">
              <div className="settings-title">
                <Eye size={20} />
                <div>
                  <h2>A workspace that feels right.</h2>
                  <p>Small details, a better everyday experience.</p>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <strong>Appearance</strong>
                  <p>Choose the light that works for you.</p>
                </div>
                <select
                  aria-label="Appearance"
                  value={data?.settings.theme ?? "light"}
                  onChange={(e) => void save({ theme: e.target.value })}
                >
                  <option value="system">System</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </div>
              <div className="setting-row">
                <div>
                  <strong>Timezone</strong>
                  <p>Used to make dates and reminders understandable.</p>
                </div>
                <input
                  aria-label="Timezone"
                  defaultValue={
                    data?.settings.timezone ??
                    Intl.DateTimeFormat().resolvedOptions().timeZone
                  }
                  onBlur={(e) => {
                    if (e.target.value !== data?.settings.timezone)
                      void save({ timezone: e.target.value });
                  }}
                />
              </div>
              <div className="setting-row">
                <div>
                  <strong>In-app reminders</strong>
                  <p>
                    Deliver due reminders in AURA while the app or worker is
                    running.
                  </p>
                </div>
                <button
                  className={`toggle ${data?.settings.notifications_enabled ? "on" : ""}`}
                  role="switch"
                  aria-checked={Boolean(data?.settings.notifications_enabled)}
                  aria-label="Enable in-app reminders"
                  onClick={() =>
                    void save({
                      notifications_enabled:
                        !data?.settings.notifications_enabled,
                    })
                  }
                >
                  <span />
                </button>
              </div>
              <div className="setting-row">
                <div>
                  <strong>Browser notifications</strong>
                  <p>
                    {notificationState === "granted"
                      ? "Allowed by this browser. AURA can show new reminder notifications while open."
                      : notificationState === "denied"
                        ? "Blocked by this browser. Change site permissions to enable alerts; in-app reminders remain available."
                        : notificationState === "unsupported"
                          ? "This browser does not support system notifications. In-app reminders remain available."
                          : "Optional PC alerts while AURA is open. Requires your browser’s permission."}
                  </p>
                </div>
                <button
                  className="button secondary small"
                  disabled={
                    notificationState === "unsupported" ||
                    notificationState === "denied" ||
                    notificationState === "granted"
                  }
                  onClick={async () => {
                    const permission = await Notification.requestPermission();
                    setNotificationState(permission);
                    if (permission === "granted")
                      await save({ notifications_enabled: true });
                  }}
                >
                  <Bell size={14} />
                  {notificationState === "granted" ? "Allowed" : "Enable"}
                </button>
              </div>
            </section>
            <section className="panel settings-panel danger-panel">
              <div className="settings-title">
                <Trash2 size={20} />
                <div>
                  <h2>Leave no loose ends.</h2>
                  <p>Delete your account and its workspace data permanently.</p>
                </div>
              </div>
              <button
                className="button danger secondary"
                onClick={() => setDeleting(true)}
              >
                Delete my account
              </button>
            </section>
          </div>
          <aside className="settings-secondary">
            <section className="privacy-card">
              <ShieldCheck size={25} />
              <h2>Trust is a daily practice.</h2>
              <p>
                AURA asks before it acts. Your memories are yours to edit. Your
                connected services are yours to revoke.
              </p>
              <ul>
                <li>
                  <Check size={14} /> User-scoped workspace data
                </li>
                <li>
                  <Check size={14} /> Server-side API credentials
                </li>
                <li>
                  <Check size={14} /> Reviewed consequential actions
                </li>
                <li>
                  <Check size={14} /> A record of important activity
                </li>
              </ul>
            </section>
            <section className="panel settings-panel">
              <div className="settings-title">
                <Cpu size={18} />
                <h2>AI connection</h2>
              </div>
              {status.data ? (
                <>
                  <StatusPill tone={status.data.configured ? "green" : "amber"}>
                    {status.data.configured
                      ? "Configured"
                      : "Configuration needed"}
                  </StatusPill>
                  <div className="provider-detail">
                    <strong>{status.data.provider}</strong>
                    <p>{status.data.model}</p>
                  </div>
                  {!status.data.configured && (
                    <p className="form-help">
                      Add your provider API key to the server’s .env.local file.
                      Your key never belongs in the browser.
                    </p>
                  )}
                </>
              ) : (
                <p className="form-help">
                  AI keys and model configuration are managed on the server. An
                  unavailable provider returns a clear error in chat.
                </p>
              )}
            </section>
            <section className="panel settings-panel">
              <div className="settings-title">
                <FileClock size={18} />
                <h2>Recent activity</h2>
              </div>
              {audit.error ? (
                <p className="form-help">Activity could not be loaded.</p>
              ) : audit.data?.items.length ? (
                <div className="audit-list">
                  {audit.data.items.slice(0, 8).map((a) => (
                    <div key={a.id}>
                      <span className="audit-dot" />
                      <div>
                        <strong>
                          {String(
                            a.action ?? a.event ?? "Workspace activity",
                          ).replace(/[_.]/g, " ")}
                        </strong>
                        <small>{formatDate(a.created_at, true)}</small>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="form-help">
                  Important workspace actions will appear here as you use AURA.
                </p>
              )}
            </section>
          </aside>
        </div>
      )}
      {editing !== undefined && (
        <Modal
          title={editing ? "Edit a memory" : "Something worth remembering"}
          onClose={() => setEditing(undefined)}
        >
          <ErrorBanner message={message} />
          <form
            className="edit-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const f = new FormData(e.currentTarget);
              try {
                await request(
                  `/api/memories${editing ? `/${editing.id}` : ""}`,
                  {
                    method: editing ? "PATCH" : "POST",
                    body: JSON.stringify({
                      title: f.get("title"),
                      content: f.get("content"),
                      kind: f.get("kind"),
                    }),
                  },
                );
                setEditing(undefined);
                await memories.reload();
                setSuccess(
                  "Memory saved. You can edit or delete it whenever you like.",
                );
              } catch (err) {
                setMessage(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Title
              <input
                name="title"
                required
                maxLength={200}
                defaultValue={String(editing?.title ?? "")}
                autoFocus
                placeholder="For example, how I like to learn"
              />
            </label>
            <label>
              Memory
              <textarea
                name="content"
                required
                rows={4}
                maxLength={10000}
                defaultValue={String(editing?.content ?? "")}
                placeholder="Only save what you’re comfortable sharing with your configured AI provider."
              />
            </label>
            <label>
              Type
              <select
                name="kind"
                defaultValue={String(editing?.kind ?? "preference")}
              >
                <option value="preference">Preference</option>
                <option value="fact">Fact</option>
                <option value="goal">Goal</option>
                <option value="context">Context</option>
              </select>
            </label>
            <p className="form-help">
              <LockKeyhole size={13} /> Saving this memory is your explicit
              choice. It is retrieved for AI only when memory is enabled.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setEditing(undefined)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? <Spinner /> : <Check size={15} />} Save memory
              </button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="Delete your workspace?"
          onClose={() => setDeleting(false)}
        >
          <p className="muted">
            This permanently deletes your notes, tasks, documents,
            conversations, memories, connections, and account. It cannot be
            undone.
          </p>
          <form
            className="edit-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const f = new FormData(e.currentTarget);
              try {
                await request("/api/settings", {
                  method: "DELETE",
                  body: JSON.stringify({
                    password: f.get("password"),
                    confirmation: f.get("confirmation"),
                  }),
                });
                router.replace("/signup");
              } catch (err) {
                setMessage(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Current password
              <input
                type="password"
                name="password"
                required
                autoComplete="current-password"
              />
            </label>
            <label>
              Type DELETE MY ACCOUNT to confirm
              <input
                name="confirmation"
                required
                pattern="DELETE MY ACCOUNT"
                autoComplete="off"
              />
            </label>
            <ErrorBanner message={message} />
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDeleting(false)}
              >
                Keep my workspace
              </button>
              <button className="button danger" disabled={busy}>
                {busy ? <Spinner /> : <Trash2 size={15} />} Delete permanently
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
