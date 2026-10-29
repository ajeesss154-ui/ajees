"use client";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ArrowDown,
  ArrowRight,
  AudioLines,
  BookOpen,
  Check,
  CheckSquare2,
  ChevronDown,
  CircleStop,
  Clock3,
  FileCheck2,
  MessageSquare,
  Mic,
  MicOff,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { SourceReference } from "@/lib/contracts";
import {
  ErrorBanner,
  errorMessage,
  formatDate,
  RecordData,
  request,
  Spinner,
  StatusPill,
  useResource,
} from "./ui";
type ChatMessage = {
  id: string;
  role: string;
  content: string;
  sources?: SourceReference[];
  created_at?: string;
};
type Approval = {
  id: string;
  tool_name: string;
  input: unknown;
  status: string;
  expires_at: string;
  result?: unknown;
};
type SpeechResult = { isFinal: boolean; 0: { transcript: string } };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: { results: ArrayLike<SpeechResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};
export function AssistantScreen() {
  const params = useSearchParams(),
    history = useResource<{ conversations: RecordData[] }>(
      "/api/conversations",
    );
  const [conversationId, setConversationId] = useState<string | undefined>(),
    [messages, setMessages] = useState<ChatMessage[]>([]),
    [approvals, setApprovals] = useState<Approval[]>([]),
    [input, setInput] = useState(""),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [listening, setListening] = useState(false),
    [speakReplies, setSpeakReplies] = useState(false),
    [voiceSupported, setVoiceSupported] = useState(false),
    [approving, setApproving] = useState<string | null>(null),
    [showHistory, setShowHistory] = useState(false);
  const end = useRef<HTMLDivElement>(null),
    controller = useRef<AbortController | null>(null),
    recognition = useRef<Recognition | null>(null),
    form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const w = window as unknown as {
      SpeechRecognition?: new () => Recognition;
      webkitSpeechRecognition?: new () => Recognition;
    };
    setVoiceSupported(
      Boolean(w.SpeechRecognition || w.webkitSpeechRecognition),
    );
    return () => {
      controller.current?.abort();
      recognition.current?.abort();
      window.speechSynthesis?.cancel();
    };
  }, []);
  useEffect(() => {
    if (params.get("prompt")) setInput(params.get("prompt") ?? "");
    if (params.get("conversation"))
      void loadConversation(params.get("conversation")!);
  }, [params]);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, status, approvals]);
  async function loadConversation(id: string) {
    controller.current?.abort();
    setBusy(false);
    setStatus("");
    setError("");
    setShowHistory(false);
    try {
      const r = await request<{
        conversation: RecordData;
        messages: ChatMessage[];
        approvals: Approval[];
      }>(`/api/conversations/${id}`);
      setConversationId(id);
      setMessages(r.messages);
      setApprovals(r.approvals);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  function newConversation() {
    controller.current?.abort();
    setBusy(false);
    setConversationId(undefined);
    setMessages([]);
    setApprovals([]);
    setError("");
    setStatus("");
    setShowHistory(false);
    window.speechSynthesis?.cancel();
  }
  async function send() {
    if (!input.trim() || busy) return;
    recognition.current?.stop();
    setListening(false);
    const text = input.trim();
    setInput("");
    setError("");
    setBusy(true);
    setStatus("Getting ready to think with you…");
    const userId = crypto.randomUUID(),
      assistantId = crypto.randomUUID();
    setMessages((old) => [
      ...old,
      { id: userId, role: "user", content: text },
      { id: assistantId, role: "assistant", content: "" },
    ]);
    const abort = new AbortController();
    controller.current = abort;
    let reply = "";
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          ...(conversationId ? { conversationId } : {}),
        }),
        signal: abort.signal,
      });
      if (!response.ok) {
        const r = await response.json();
        throw new Error(
          typeof r.error === "string"
            ? r.error
            : (r.error?.message ?? "AURA couldn’t respond. Please try again."),
        );
      }
      if (!response.body)
        throw new Error("Your browser could not read the response stream.");
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      const process = (raw: string) => {
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const event = JSON.parse(line.slice(5).trim()) as {
            type: string;
            [key: string]: unknown;
          };
          if (event.type === "status") {
            setStatus(String(event.message ?? "Thinking…"));
            if (event.conversationId)
              setConversationId(String(event.conversationId));
          } else if (event.type === "delta") {
            reply += String(event.text ?? "");
            setMessages((old) =>
              old.map((m) =>
                m.id === assistantId ? { ...m, content: reply } : m,
              ),
            );
          } else if (event.type === "sources") {
            setMessages((old) =>
              old.map((m) =>
                m.id === assistantId
                  ? { ...m, sources: event.sources as SourceReference[] }
                  : m,
              ),
            );
          } else if (event.type === "approval") {
            setApprovals((old) => [
              ...old.filter((a) => a.id !== (event.approval as Approval).id),
              event.approval as Approval,
            ]);
          } else if (event.type === "error")
            throw new Error(String(event.message));
          else if (event.type === "done") {
            if (event.conversationId)
              setConversationId(String(event.conversationId));
            setStatus("");
          }
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() ?? "";
        parts.forEach(process);
        if (done) {
          if (buffer.trim()) process(buffer);
          break;
        }
      }
      if (speakReplies && reply && window.speechSynthesis) {
        const speech = new SpeechSynthesisUtterance(reply.slice(0, 10000));
        speech.rate = 1;
        window.speechSynthesis.speak(speech);
      }
      await history.reload();
    } catch (e) {
      if (!(e instanceof Error && e.name === "AbortError")) {
        setError(errorMessage(e));
        setMessages((old) =>
          old.filter((m) => m.id !== assistantId || m.content),
        );
      }
    } finally {
      setBusy(false);
      setStatus("");
      controller.current = null;
    }
  }
  async function decide(approval: Approval, decision: "approve" | "reject") {
    setApproving(approval.id);
    setError("");
    try {
      const r = await request<{ approval: Approval; result: unknown }>(
        `/api/approvals/${approval.id}`,
        { method: "POST", body: JSON.stringify({ decision }) },
      );
      setApprovals((old) =>
        old.map((a) =>
          a.id === approval.id ? { ...a, ...r.approval, result: r.result } : a,
        ),
      );
      if (conversationId) {
        const c = await request<{
          messages: ChatMessage[];
          approvals: Approval[];
        }>(`/api/conversations/${conversationId}`);
        setMessages(c.messages);
        setApprovals(c.approvals);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setApproving(null);
    }
  }
  function toggleMic() {
    if (listening) {
      recognition.current?.stop();
      setListening(false);
      return;
    }
    const w = window as unknown as {
      SpeechRecognition?: new () => Recognition;
      webkitSpeechRecognition?: new () => Recognition;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      setError(
        "Voice input isn’t supported in this browser. Try Chrome or Edge, or continue typing.",
      );
      return;
    }
    window.speechSynthesis?.cancel();
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.continuous = false;
    r.interimResults = false;
    r.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0].transcript)
        .join(" ");
      setInput((old) => `${old} ${transcript}`.trim());
    };
    r.onerror = (event) => {
      setListening(false);
      setError(
        event.error === "not-allowed"
          ? "Microphone permission was denied. Allow it in browser site settings, or type your message."
          : `Voice input stopped: ${event.error}. You can keep typing.`,
      );
    };
    r.onend = () => setListening(false);
    recognition.current = r;
    try {
      r.start();
      setListening(true);
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <div className="assistant-layout">
      <aside className={`conversation-sidebar ${showHistory ? "show" : ""}`}>
        <div className="conversation-heading">
          <span>YOUR CONVERSATIONS</span>
          <button
            className="icon-button"
            aria-label="New conversation"
            onClick={newConversation}
          >
            <Plus size={17} />
          </button>
        </div>
        <button className="new-chat-button" onClick={newConversation}>
          <Plus size={16} /> A fresh conversation
        </button>
        {history.loading ? (
          <Spinner />
        ) : history.data?.conversations.length ? (
          <div className="conversation-list">
            {history.data.conversations.map((c) => (
              <div
                className={`conversation-list-item ${conversationId === c.id ? "selected" : ""}`}
                key={c.id}
              >
                <button onClick={() => void loadConversation(c.id)}>
                  <MessageSquare size={15} />
                  <span>{String(c.title || "Untitled conversation")}</span>
                </button>
                <button
                  aria-label={`Delete conversation ${c.title}`}
                  className="conversation-delete"
                  onClick={async () => {
                    if (
                      confirm(
                        "Delete this conversation and its pending approvals?",
                      )
                    ) {
                      try {
                        await request(`/api/conversations/${c.id}`, {
                          method: "DELETE",
                        });
                        if (conversationId === c.id) newConversation();
                        await history.reload();
                      } catch (e) {
                        setError(errorMessage(e));
                      }
                    }
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="history-empty">
            Your conversations will live here. Start with whatever’s on your
            mind.
          </p>
        )}
        <div className="conversation-privacy">
          <ShieldCheck size={17} />
          <p>
            You’re in control.
            <br />
            <span>
              Actions wait for your approval. Memories are saved only when you
              choose.
            </span>
          </p>
        </div>
      </aside>
      <section className="chat-main">
        <div className="chat-topline">
          <div>
            <span className="chat-logo">
              <Sparkles size={19} />
            </span>
            <h1>AURA Assistant</h1>
            <span className="pill green">Personal AI</span>
          </div>
          <button
            className="button secondary small history-toggle"
            onClick={() => setShowHistory(!showHistory)}
          >
            <MessageSquare size={14} /> History
          </button>
          <button
            className={`icon-button ${speakReplies ? "enabled" : ""}`}
            title={
              speakReplies ? "Turn spoken replies off" : "Read replies aloud"
            }
            aria-label={
              speakReplies ? "Turn spoken replies off" : "Read replies aloud"
            }
            onClick={() => {
              setSpeakReplies(!speakReplies);
              window.speechSynthesis?.cancel();
            }}
          >
            {speakReplies ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>
        </div>
        <div className="chat-scroll">
          {!messages.length ? (
            <div className="chat-welcome">
              <div className="welcome-orb">
                <Sparkles size={33} strokeWidth={1} />
              </div>
              <div className="eyebrow">A LITTLE SPACE TO THINK</div>
              <h2>
                What shall we make
                <br />
                possible today?
              </h2>
              <p>
                Bring a thought, a question, or a plan.
                <br />
                We’ll find the next step together.
              </p>
              <div className="starter-grid">
                {[
                  {
                    icon: CheckSquare2,
                    title: "Bring order to my day",
                    prompt:
                      "Look at my pending tasks and help me plan a focused day.",
                  },
                  {
                    icon: BookOpen,
                    title: "Find the thought I saved",
                    prompt: "Help me find a note. What would you like to know?",
                  },
                  {
                    icon: FileCheck2,
                    title: "Turn a note into next steps",
                    prompt:
                      "Help me turn one of my notes into tasks. Show me the proposed tasks for review.",
                  },
                  {
                    icon: Sparkles,
                    title: "Think through an idea",
                    prompt:
                      "I have an idea I’d like to think through with you.",
                  },
                ].map((s) => (
                  <button key={s.title} onClick={() => setInput(s.prompt)}>
                    <s.icon size={18} />
                    <span>{s.title}</span>
                    <ArrowRight size={15} />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="message-list">
              {messages.map((m) => (
                <div key={m.id} className={`chat-message ${m.role}`}>
                  <div className="message-avatar">
                    {m.role === "user" ? "You" : <Sparkles size={17} />}
                  </div>
                  <div className="message-body">
                    <div className="message-author">
                      {m.role === "user"
                        ? "You"
                        : m.role === "tool"
                          ? "Workspace result"
                          : "AURA"}
                    </div>
                    {m.content ? (
                      <div className="message-content">{m.content}</div>
                    ) : busy ? (
                      <div className="thinking-dots">
                        <i />
                        <i />
                        <i />
                      </div>
                    ) : null}
                    {m.sources?.length ? (
                      <div className="source-references">
                        <div className="source-label">
                          <BookOpen size={13} /> FROM YOUR WORKSPACE
                        </div>
                        {m.sources.map((s, i) => (
                          <details className="source-card" key={`${s.id}-${i}`}>
                            <summary>
                              <span className="source-number">{i + 1}</span>
                              <span>{s.title}</span>
                              <small>{s.location || s.type}</small>
                              <ChevronDown size={13} />
                            </summary>
                            <p>{s.excerpt}</p>
                          </details>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
          {approvals.length > 0 && (
            <div className="approval-list">
              {approvals.map((a) => (
                <div key={a.id} className={`approval-card ${a.status}`}>
                  <div className="approval-title">
                    <ShieldCheck size={18} />
                    <strong>
                      {a.status === "pending"
                        ? "Your approval, before anything happens"
                        : a.status === "rejected"
                          ? "You chose not to proceed"
                          : a.status === "executed" ||
                              a.status === "approved" ||
                              a.status === "completed"
                            ? "Confirmed by your workspace"
                            : "Action status"}
                    </strong>
                    <StatusPill
                      tone={
                        a.status === "pending"
                          ? "amber"
                          : a.status === "failed"
                            ? "red"
                            : "green"
                      }
                    >
                      {a.status}
                    </StatusPill>
                  </div>
                  <h3>{a.tool_name.replace(/[_.]/g, " ")}</h3>
                  <pre>{JSON.stringify(a.input, null, 2)}</pre>
                  {a.status === "pending" ? (
                    <div className="approval-actions">
                      <span>
                        <Clock3 size={12} /> Expires{" "}
                        {formatDate(a.expires_at, true)}
                      </span>
                      <button
                        className="button secondary small"
                        disabled={Boolean(approving)}
                        onClick={() => void decide(a, "reject")}
                      >
                        <X size={13} /> Decline
                      </button>
                      <button
                        className="button primary small"
                        disabled={Boolean(approving)}
                        onClick={() => void decide(a, "approve")}
                      >
                        {approving === a.id ? <Spinner /> : <Check size={13} />}{" "}
                        Approve action
                      </button>
                    </div>
                  ) : a.result ? (
                    <details>
                      <summary>View actual result</summary>
                      <pre>{JSON.stringify(a.result, null, 2)}</pre>
                    </details>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          {status && (
            <div className="chat-status" role="status">
              <Spinner />
              {status}
            </div>
          )}
          <div ref={end} />
        </div>
        <div className="chat-composer-area">
          <ErrorBanner message={error} />
          {listening && (
            <div className="listening-status">
              <span className="recording-dot" /> Listening… speak naturally.
              Recognized text appears below.
              <button onClick={toggleMic}>Stop</button>
            </div>
          )}
          <form
            ref={form}
            className="chat-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  form.current?.requestSubmit();
                }
              }}
              placeholder="Ask a question, share a thought, or make a plan…"
              aria-label="Message AURA"
              maxLength={12000}
              disabled={busy}
            />
            <div className="composer-bottom">
              <span>
                <Sparkles size={13} /> Connected to your workspace
              </span>
              <div>
                <button
                  type="button"
                  className={`icon-button ${listening ? "listening" : ""}`}
                  aria-label={
                    listening ? "Stop listening" : "Start voice input"
                  }
                  title={
                    voiceSupported
                      ? "Dictate a message"
                      : "Voice support depends on your browser"
                  }
                  onClick={toggleMic}
                >
                  {listening ? <MicOff size={19} /> : <Mic size={19} />}
                </button>
                {busy ? (
                  <button
                    type="button"
                    className="send-button stop"
                    onClick={() => controller.current?.abort()}
                    aria-label="Stop response"
                  >
                    <Square size={15} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    className="send-button"
                    type="submit"
                    aria-label="Send message"
                    disabled={!input.trim()}
                  >
                    <ArrowRight size={20} />
                  </button>
                )}
              </div>
            </div>
          </form>
          <p className="composer-disclaimer">
            AURA can make mistakes. Review important details. Your actions
            always need your say-so.
          </p>
        </div>
      </section>
    </div>
  );
}
