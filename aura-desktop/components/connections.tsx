"use client";
import Link from "next/link";
import { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  CircleHelp,
  Clock3,
  Link2,
  Mail,
  Network,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import {
  EmptyState,
  ErrorBanner,
  errorMessage,
  formatDate,
  PageHeader,
  RecordData,
  request,
  Spinner,
  StatusPill,
  useResource,
} from "./ui";
type Integration = {
  provider: string;
  status: string;
  configured: boolean;
  writeEnabled?: boolean;
  scopes: string[];
  message?: string;
};
export function ConnectionsScreen() {
  const { data, error, loading, reload } = useResource<{
      integrations: Integration[];
    }>("/api/integrations"),
    [busy, setBusy] = useState<string | null>(null),
    [message, setMessage] = useState(""),
    [allowWrites, setAllowWrites] = useState<Record<string, boolean>>({});
  return (
    <>
      <PageHeader
        eyebrow="CONNECTED, ON YOUR TERMS"
        title="Let your workspace work together."
        description="Connect the services you choose. Give AURA useful context, without giving up control."
      />
      <ErrorBanner message={error || message} />
      <section className="connection-trust">
        <span className="trust-icon">
          <ShieldCheck size={25} />
        </span>
        <div>
          <h2>A connection is a choice. So is every action.</h2>
          <p>
            Read only what you authorize. Review proposed changes. Disconnect
            whenever you like.
          </p>
        </div>
        <StatusPill tone="green">Permission first</StatusPill>
      </section>
      {loading ? (
        <div className="panel panel-loading">
          <Spinner />
        </div>
      ) : (
        <div className="connections-grid">
          {[
            {
              provider: "google_calendar",
              title: "Google Calendar",
              description:
                "Find space in your day. See upcoming events and plan your time with a little more clarity.",
              icon: CalendarDays,
              color: "blue",
              scope:
                "Read your calendar. Proposed changes require your approval.",
            },
            {
              provider: "gmail",
              title: "Gmail",
              description:
                "Find the email that matters, understand the thread, and prepare a thoughtful reply.",
              icon: Mail,
              color: "coral",
              scope:
                "Search and read authorized mail. Sending always requires review.",
            },
          ].map((c) => {
            const state = data?.integrations.find(
                (i) => i.provider === c.provider,
              ),
              connected = state?.status === "connected";
            return (
              <article className="connection-card" key={c.provider}>
                <div className="connection-card-top">
                  <span className={`provider-icon ${c.color}`}>
                    <c.icon size={25} />
                  </span>
                  <StatusPill tone={connected ? "green" : "neutral"}>
                    {connected
                      ? "Connected"
                      : state?.configured
                        ? "Not connected"
                        : "Setup required"}
                  </StatusPill>
                </div>
                <h2>{c.title}</h2>
                <p>{c.description}</p>
                <div className="connection-scope">
                  <ShieldCheck size={14} />
                  {c.scope}
                </div>
                {state?.message && (
                  <div className="connection-message">{state.message}</div>
                )}
                {(!connected || !state?.writeEnabled) && (
                  <label className="write-permission">
                    <input
                      type="checkbox"
                      checked={Boolean(allowWrites[c.provider])}
                      onChange={(e) =>
                        setAllowWrites((old) => ({
                          ...old,
                          [c.provider]: e.target.checked,
                        }))
                      }
                    />{" "}
                    Allow write permissions (every action still needs review)
                  </label>
                )}
                <button
                  disabled={busy === c.provider}
                  className={`button full ${connected ? "secondary" : "primary"}`}
                  onClick={async () => {
                    setBusy(c.provider);
                    setMessage("");
                    try {
                      if (connected) {
                        if (
                          !confirm(
                            `Disconnect ${c.title}? AURA will lose access.`,
                          )
                        )
                          return;
                        await request(`/api/integrations/${c.provider}`, {
                          method: "DELETE",
                        });
                        await reload();
                      } else {
                        const result = await request<{ url: string }>(
                          `/api/integrations/${c.provider}/connect`,
                          {
                            method: "POST",
                            body: JSON.stringify({
                              allowWrites: Boolean(allowWrites[c.provider]),
                            }),
                          },
                        );
                        window.location.assign(result.url);
                      }
                    } catch (e) {
                      setMessage(errorMessage(e));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === c.provider ? (
                    <Spinner />
                  ) : connected ? (
                    <Unplug size={16} />
                  ) : (
                    <Link2 size={16} />
                  )}{" "}
                  {connected ? "Disconnect" : `Connect ${c.title}`}{" "}
                  {!connected && <ArrowUpRight size={15} />}
                </button>
                {connected && !state?.writeEnabled && (
                  <>
                    <p className="read-only-note">
                      Connected with read-only access. Select write permissions
                      above to review an upgrade with Google.
                    </p>
                    <button
                      className="button secondary full upgrade-button"
                      disabled={!allowWrites[c.provider] || busy === c.provider}
                      onClick={async () => {
                        setBusy(c.provider);
                        setMessage("");
                        try {
                          const r = await request<{ url: string }>(
                            `/api/integrations/${c.provider}/connect`,
                            {
                              method: "POST",
                              body: JSON.stringify({ allowWrites: true }),
                            },
                          );
                          window.location.assign(r.url);
                        } catch (e) {
                          setMessage(errorMessage(e));
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      Review write permissions <ArrowUpRight size={14} />
                    </button>
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}
      <section className="panel connection-details">
        <h2>Your permissions, at a glance.</h2>
        <div>
          <span>
            <Check size={16} /> Official Google OAuth APIs
          </span>
          <span>
            <Check size={16} /> Encrypted server-side credentials
          </span>
          <span>
            <Check size={16} /> No password sharing
          </span>
          <span>
            <Check size={16} /> Revoke access at any time
          </span>
        </div>
        <p>
          Connections require Google OAuth credentials configured by the owner
          of this AURA installation. Unconfigured services show their actual
          status; no sample inboxes or calendars are displayed.
        </p>
      </section>
      <div className="roadmap-callout">
        <Network size={21} />
        <div>
          <strong>More useful connections, thoughtfully added.</strong>
          <p>Communication, travel, learning, and more are on the roadmap.</p>
        </div>
        <Link href="/roadmap" className="text-link">
          See what’s next <ArrowRight size={14} />
        </Link>
      </div>
    </>
  );
}
export function CalendarScreen() {
  const { data, error, loading } = useResource<{ events: RecordData[] }>(
    "/api/calendar/events",
  );
  return (
    <>
      <PageHeader
        eyebrow="TIME FOR WHAT MATTERS"
        title="A little more space in your day."
        description="Your upcoming events, with a companion to help you make the most of the time between."
        action={
          <Link
            href="/assistant?prompt=Check%20my%20calendar%20and%20tasks%20and%20help%20me%20plan%20my%20day"
            className="button primary"
          >
            <CalendarDays size={16} /> Plan with AURA
          </Link>
        }
      />
      {loading ? (
        <div className="panel panel-loading">
          <Spinner />
        </div>
      ) : error ? (
        <div className="panel calendar-empty">
          <EmptyState
            icon={CalendarDays}
            title="Bring your calendar into the picture."
            description={error}
            action={
              <Link href="/connections" className="button primary">
                Manage calendar connection <ArrowRight size={16} />
              </Link>
            }
          />
        </div>
      ) : data?.events.length ? (
        <div className="panel calendar-events">
          <div className="section-heading">
            <h2>Coming up</h2>
            <StatusPill tone="green">Google Calendar</StatusPill>
          </div>
          {data.events.map((e) => (
            <article key={e.id} className="calendar-event">
              <div className="event-icon">
                <CalendarDays size={21} />
              </div>
              <div>
                <h2>{String(e.summary ?? e.title ?? "Untitled event")}</h2>
                <p>
                  {formatDate(
                    typeof e.start === "object" && e.start
                      ? ((e.start as Record<string, unknown>).dateTime ??
                          (e.start as Record<string, unknown>).date)
                      : e.start,
                    true,
                  )}
                  {e.location ? ` · ${String(e.location)}` : ""}
                </p>
              </div>
              {e.htmlLink ? (
                <a
                  className="icon-button"
                  href={String(e.htmlLink)}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open event in Google Calendar"
                >
                  <ArrowUpRight size={17} />
                </a>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="panel">
          <EmptyState
            icon={CalendarDays}
            title="A little breathing room."
            description="No upcoming events were returned by your connected calendar. Ask AURA to help plan your next focus session."
          />
        </div>
      )}
      <div className="knowledge-note">
        <ShieldCheck size={17} />
        <p>
          AURA can propose calendar changes for you to review. An event is only
          created, edited, or deleted after you explicitly approve it and Google
          confirms the result.
        </p>
      </div>
    </>
  );
}
