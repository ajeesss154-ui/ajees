"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  FileText,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  UploadCloud,
} from "lucide-react";
import {
  EmptyState,
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
export function KnowledgeScreen() {
  const { data, error, loading, reload } = useResource<{ items: RecordData[] }>(
      "/api/documents",
    ),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [selected, setSelected] = useState<RecordData | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  async function upload(file?: File) {
    if (!file) return;
    setBusy(true);
    setMessage("");
    const form = new FormData();
    form.append("file", file);
    try {
      await request("/api/documents", { method: "POST", body: form });
      await reload();
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="YOUR KNOWLEDGE, CONNECTED"
        title="Make room for understanding."
        description="A library that helps you think. Bring your documents, then ask better questions."
        action={
          <button
            className="button primary"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            {busy ? <Spinner /> : <Plus size={16} />} Upload document
          </button>
        }
      />
      <input
        ref={fileInput}
        type="file"
        accept=".pdf,.txt,.md,.markdown,.docx"
        className="visually-hidden"
        aria-label="Upload document"
        onChange={(e) => void upload(e.target.files?.[0])}
      />
      <ErrorBanner message={error || message} />
      <div
        className={`upload-zone ${busy ? "busy" : ""}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (!busy) void upload(e.dataTransfer.files[0]);
        }}
      >
        <span className="upload-icon">
          <UploadCloud size={27} strokeWidth={1.3} />
        </span>
        <div>
          <h2>A little context goes a long way.</h2>
          <p>
            Drop a document here, or{" "}
            <button onClick={() => fileInput.current?.click()} disabled={busy}>
              browse your files
            </button>
          </p>
          <small>
            PDF, TXT, Markdown, DOCX · Up to 5 MB · Text-based documents
          </small>
        </div>
        <span className="upload-private">
          <ShieldCheck size={14} /> Only in your workspace
        </span>
      </div>
      <div className="resource-toolbar">
        <div className="search-field">
          <Search size={17} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a document…"
            aria-label="Search documents"
          />
        </div>
        <span className="muted">
          {data?.items.length ?? 0} documents in your library
        </span>
      </div>
      {loading ? (
        <div className="panel panel-loading">
          <Spinner />
        </div>
      ) : (data?.items ?? []).filter((d) =>
          `${d.title} ${d.filename}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        ).length ? (
        <div className="document-grid">
          {data?.items
            .filter((d) =>
              `${d.title} ${d.filename}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((d) => (
              <article className="document-card" key={d.id}>
                <div className="document-icon">
                  <FileText size={26} strokeWidth={1.3} />
                </div>
                <div className="document-card-title">
                  <h2>{String(d.title ?? d.filename)}</h2>
                  <StatusPill>
                    {String(d.filename ?? "")
                      .split(".")
                      .pop()
                      ?.toUpperCase()}
                  </StatusPill>
                </div>
                <p>
                  {formatDate(d.created_at)} ·{" "}
                  {(Number(d.size_bytes ?? 0) / 1024).toFixed(0)} KB
                </p>
                <div className="document-card-actions">
                  <button
                    className="text-link"
                    onClick={async () => {
                      try {
                        const r = await request<{ item: RecordData }>(
                          `/api/documents/${d.id}`,
                        );
                        setSelected(r.item);
                      } catch (e) {
                        setMessage(errorMessage(e));
                      }
                    }}
                  >
                    Read extracted text <ArrowUpRight size={13} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Delete document ${d.title}`}
                    onClick={async () => {
                      if (
                        confirm("Delete this document and its search index?")
                      ) {
                        try {
                          await request(`/api/documents/${d.id}`, {
                            method: "DELETE",
                          });
                          await reload();
                        } catch (e) {
                          setMessage(errorMessage(e));
                        }
                      }
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <Link
                  className="button secondary small full"
                  href={`/assistant?prompt=${encodeURIComponent(`Find my document titled "${d.title ?? d.filename}", summarize it, and cite the source.`)}`}
                >
                  <BookOpen size={14} /> Ask AURA about this
                </Link>
              </article>
            ))}
        </div>
      ) : (
        <div className="panel">
          <EmptyState
            icon={BookOpen}
            title={
              query
                ? "No documents match that search"
                : "Knowledge starts with a little curiosity."
            }
            description={
              query
                ? "Try a different title or filename."
                : "Upload your first document. Ask AURA to explain it, summarize it, or find the detail you need — with source references."
            }
            action={
              <button
                className="button secondary"
                onClick={() => fileInput.current?.click()}
              >
                <UploadCloud size={16} /> Bring your first document
              </button>
            }
          />
        </div>
      )}
      <div className="knowledge-note">
        <ShieldCheck size={17} />
        <p>
          <strong>Context, with boundaries.</strong> Your documents are scoped
          to your account. Text inside files is treated as reference material,
          never permission to take action. Scanned PDFs may need OCR before
          uploading.
        </p>
      </div>
      {selected && (
        <Modal
          title={String(selected.title ?? selected.filename)}
          onClose={() => setSelected(null)}
          wide
        >
          <div className="document-reader">
            {String(selected.content ?? "No extracted text is available.")}
          </div>
          <div className="modal-actions">
            <Link
              className="button primary"
              href={`/assistant?prompt=${encodeURIComponent(`Find and summarize my document "${selected.title ?? selected.filename}" with source references.`)}`}
            >
              Discuss with AURA <ArrowUpRight size={15} />
            </Link>
          </div>
        </Modal>
      )}
    </>
  );
}
