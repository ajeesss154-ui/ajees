"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  AudioLines,
  Bell,
  BookOpen,
  CalendarDays,
  CheckCheck,
  CheckSquare2,
  ChevronDown,
  Command,
  Grid2X2,
  House,
  LogOut,
  Menu,
  Moon,
  Network,
  Search,
  Settings2,
  Sparkles,
  StickyNote,
  Sun,
  X,
} from "lucide-react";
import type { User } from "@/lib/contracts";
import {
  request,
  Spinner,
  formatDate,
  RecordData,
  ErrorBanner,
  errorMessage,
} from "./ui";
import { applyTheme, cachedTheme, THEME_CHANGED_EVENT } from "./theme";
const SessionContext = createContext<User | null>(null);
export function useSession() {
  return useContext(SessionContext);
}
const navigation = [
  { href: "/home", label: "Home", icon: House },
  { href: "/assistant", label: "AI Assistant", icon: AudioLines },
  { href: "/tasks", label: "Tasks", icon: CheckSquare2 },
  { href: "/notes", label: "Notes", icon: StickyNote },
  { href: "/knowledge", label: "Knowledge", icon: BookOpen },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
];
export function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null),
    [loaded, setLoaded] = useState(false),
    [mobile, setMobile] = useState(false),
    [dark, setDark] = useState(false),
    [query, setQuery] = useState(""),
    [notifications, setNotifications] = useState<RecordData[] | null>(null),
    [noticeError, setNoticeError] = useState("");
  const router = useRouter(),
    path = usePathname(),
    searchRef = useRef<HTMLInputElement>(null);
  const [unread, setUnread] = useState(0),
    [themeError, setThemeError] = useState("");
  useEffect(() => {
    let active = true;
    request<{ user: User }>("/api/auth/me")
      .then(async (r) => {
        if (!active) return;
        setUser(r.user);
        try {
          const prefs = await request<{ settings: { theme: string } }>(
            "/api/settings",
          );
          if (active) applyTheme(prefs.settings.theme);
        } catch {
          /* Keep the cached preference if settings are temporarily unavailable. */
        }
      })
      .catch(() => {
        if (active) router.replace("/login");
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [router]);
  useEffect(() => {
    const sync = () =>
      setDark(document.documentElement.dataset.theme === "dark");
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => {
      if (cachedTheme() === "system") applyTheme("system");
    };
    window.addEventListener(THEME_CHANGED_EVENT, sync);
    media.addEventListener("change", onSystemChange);
    applyTheme(cachedTheme());
    return () => {
      window.removeEventListener(THEME_CHANGED_EVENT, sync);
      media.removeEventListener("change", onSystemChange);
    };
  }, []);
  useEffect(() => setMobile(false), [path]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  useEffect(() => {
    if (!user) return;
    let active = true,
      initialized = false;
    const seen = new Set<string>();
    async function poll() {
      try {
        const [r, prefs] = await Promise.all([
          request<{ items: RecordData[] }>("/api/notifications"),
          request<{ settings: { notifications_enabled: boolean } }>(
            "/api/settings",
          ),
        ]);
        if (!active) return;
        setUnread(r.items.filter((n) => !n.read_at).length);
        setNotifications((old) => (old ? r.items : null));
        for (const n of r.items) {
          if (
            initialized &&
            !seen.has(n.id) &&
            !n.read_at &&
            prefs.settings.notifications_enabled &&
            "Notification" in window &&
            Notification.permission === "granted"
          ) {
            try {
              const alert = new Notification(
                String(n.title ?? "AURA reminder"),
                {
                  body: String(n.body ?? "Your reminder is due."),
                  tag: `aura-${n.id}`,
                },
              );
              alert.onclick = () => {
                window.focus();
                alert.close();
              };
            } catch {
              /* Browser may disallow alerts despite permission. In-app delivery is retained. */
            }
          }
          seen.add(n.id);
        }
        initialized = true;
      } catch {
        /* The bell surfaces loading failures; polling retries without interrupting work. */
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 30000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [user]);
  async function toggleTheme() {
    const previous = cachedTheme(),
      next = dark ? "light" : "dark";
    setThemeError("");
    applyTheme(next);
    try {
      await request("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ theme: next }),
      });
    } catch (e) {
      applyTheme(previous);
      setThemeError(errorMessage(e));
    }
  }
  async function showNotifications() {
    if (notifications) {
      setNotifications(null);
      return;
    }
    try {
      const r = await request<{ items: RecordData[] }>("/api/notifications");
      setNotifications(r.items ?? []);
      setNoticeError("");
    } catch (e) {
      setNoticeError(
        e instanceof Error ? e.message : "Notifications unavailable",
      );
      setNotifications([]);
    }
  }
  async function signOut() {
    await request("/api/auth/signout", { method: "POST" });
    router.replace("/login");
  }
  if (!loaded || !user)
    return (
      <div className="boot-screen">
        <div className="brand-symbol">a</div>
        <Spinner />
        <p>Opening your workspace</p>
      </div>
    );
  return (
    <SessionContext.Provider value={user}>
      <div className="app-shell">
        {mobile && (
          <button
            className="sidebar-scrim"
            aria-label="Close navigation"
            onClick={() => setMobile(false)}
          />
        )}
        <aside className={`sidebar ${mobile ? "open" : ""}`}>
          <Link href="/home" className="brand">
            <span className="brand-symbol">a</span>
            <span>
              aura<span className="brand-dot">.</span>
            </span>
            <span className="beta-tag">BETA</span>
          </Link>
          <div className="workspace-selector">
            <div className="workspace-avatar">
              {user.name.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <strong>Personal workspace</strong>
              <span>Your space to think & do</span>
            </div>
            <ChevronDown size={14} />
          </div>
          <div className="nav-label">YOUR WORKSPACE</div>
          <nav aria-label="Main navigation">
            {navigation.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={`nav-item ${path === n.href ? "active" : ""}`}
              >
                <n.icon size={18} strokeWidth={1.7} />
                <span>{n.label}</span>
                {n.href === "/assistant" && <span className="nav-new">AI</span>}
              </Link>
            ))}
          </nav>
          <div className="sidebar-lower">
            <Link
              href="/connections"
              className={`nav-item ${path === "/connections" ? "active" : ""}`}
            >
              <Network size={18} />
              Connections
            </Link>
            <Link
              href="/settings"
              className={`nav-item ${path === "/settings" ? "active" : ""}`}
            >
              <Settings2 size={18} />
              Settings
            </Link>
            <Link href="/roadmap" className="workspace-card">
              <span className="tiny-stars">
                <Sparkles size={17} />
              </span>
              <strong>Built around you.</strong>
              <p>
                One intelligent space.
                <br />
                More possibilities ahead.
              </p>
              <span>
                Explore what’s next <ArrowUpRight size={14} />
              </span>
            </Link>
            <div className="user-footer">
              <div className="user-avatar">
                {user.name.slice(0, 1).toUpperCase()}
              </div>
              <div>
                <strong>{user.name}</strong>
                <span>Personal account</span>
              </div>
              <button
                className="icon-button"
                onClick={() => void signOut()}
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut size={16} />
              </button>
            </div>
          </div>
        </aside>
        <div className="workspace-main">
          <header className="topbar">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobile(true)}
            >
              <Menu size={21} />
            </button>
            <div className="breadcrumb">
              Workspace <span>/</span>{" "}
              <strong>
                {[
                  ...navigation,
                  { href: "/connections", label: "Connections" },
                  { href: "/settings", label: "Settings" },
                  { href: "/roadmap", label: "What’s next" },
                ].find((n) => n.href === path)?.label ?? "Workspace"}
              </strong>
            </div>
            <form
              className="global-search"
              onSubmit={(e) => {
                e.preventDefault();
                if (query.trim()) {
                  router.push(
                    `/assistant?prompt=${encodeURIComponent(query.trim())}`,
                  );
                  setQuery("");
                }
              }}
            >
              <Search size={16} />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Ask anything, find anything…"
                aria-label="Ask the assistant"
              />
              <kbd>
                <Command size={10} /> K
              </kbd>
            </form>
            <div className="topbar-actions">
              <button
                className="icon-button"
                aria-label={dark ? "Use light theme" : "Use dark theme"}
                onClick={() => void toggleTheme()}
              >
                {dark ? <Sun size={18} /> : <Moon size={18} />}
              </button>
              <div className="notification-anchor">
                <button
                  className="icon-button"
                  aria-label="View notifications"
                  onClick={() => void showNotifications()}
                >
                  <Bell size={18} />
                  {unread > 0 && (
                    <span className="notification-count">
                      {unread > 9 ? "9+" : unread}
                    </span>
                  )}
                </button>
                {notifications && (
                  <div className="notification-popover">
                    <h3>Notifications</h3>
                    {noticeError ? (
                      <p className="error-text">{noticeError}</p>
                    ) : notifications.length ? (
                      notifications.map((n) => (
                        <button
                          type="button"
                          aria-label={
                            n.read_at
                              ? `Read notification: ${n.title}`
                              : `Mark notification as read: ${n.title}`
                          }
                          className={`notification-item ${n.read_at ? "" : "unread"}`}
                          key={n.id}
                          onClick={async () => {
                            if (n.read_at) return;
                            try {
                              await request(`/api/notifications/${n.id}`, {
                                method: "PATCH",
                              });
                              setNotifications(
                                (old) =>
                                  old?.map((x) =>
                                    x.id === n.id
                                      ? {
                                          ...x,
                                          read_at: new Date().toISOString(),
                                        }
                                      : x,
                                  ) ?? null,
                              );
                              setUnread((old) => Math.max(0, old - 1));
                            } catch {
                              /* Retain unread status when the server cannot confirm. */
                            }
                          }}
                        >
                          <Bell size={15} />
                          <div>
                            <strong>{String(n.title ?? "Reminder")}</strong>
                            <p>{String(n.body ?? n.content ?? "")}</p>
                            <small>{formatDate(n.created_at, true)}</small>
                          </div>
                        </button>
                      ))
                    ) : (
                      <p>
                        You’re all caught up. Scheduled reminders will appear
                        here.
                      </p>
                    )}
                    <small>
                      In-app delivery. Your PC must be running AURA.
                    </small>
                  </div>
                )}
              </div>
              <div className="top-avatar">
                {user.name.slice(0, 1).toUpperCase()}
              </div>
            </div>
          </header>
          <main className="main-content" id="main-content">
            <ErrorBanner message={themeError} />
            {children}
          </main>
          <footer className="app-footer">
            <span>
              <span className="status-dot" /> Your workspace. Your control.
            </span>
            <Link href="/settings">
              Privacy & memory <ArrowUpRight size={12} />
            </Link>
          </footer>
        </div>
      </div>
    </SessionContext.Provider>
  );
}
