"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, Check, ShieldCheck, Sparkles } from "lucide-react";
import { ErrorBanner, errorMessage, request, Spinner } from "./ui";
export function AuthForm({ signup = false }: { signup?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="auth-page">
      <aside className="auth-story">
        <Link href="/" className="brand">
          <span className="brand-symbol">a</span>
          <span>aura.</span>
        </Link>
        <div className="auth-story-copy">
          <div className="eyebrow">YOUR PERSONAL OPERATING SPACE</div>
          <h1>
            A little more clarity.
            <br />A lot more possibility.
          </h1>
          <p>
            Your ideas, your plans, and an intelligent companion. Finally, in
            the same place.
          </p>
          <div className="auth-orbit">
            <span />
            <span />
            <span />
            <div className="orbit-core">
              <Sparkles size={36} strokeWidth={1} />
            </div>
          </div>
          <div className="auth-values">
            <span>
              <Check size={15} /> Your context, on your terms
            </span>
            <span>
              <Check size={15} /> Thoughtful action, with your approval
            </span>
            <span>
              <Check size={15} /> One connected workspace
            </span>
          </div>
        </div>
        <small>
          <ShieldCheck size={15} /> You choose what AURA remembers.
        </small>
      </aside>
      <section className="auth-panel">
        <div className="auth-box">
          <div className="eyebrow">LET’S MAKE SPACE</div>
          <h2>{signup ? "Your next chapter starts here." : "Welcome back."}</h2>
          <p>
            {signup
              ? "Create your private workspace and make room for what matters."
              : "Pick up where you left off. Your workspace is ready."}
          </p>
          <ErrorBanner message={error} />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              setBusy(true);
              const f = new FormData(e.currentTarget);
              try {
                await request(`/api/auth/${signup ? "signup" : "signin"}`, {
                  method: "POST",
                  body: JSON.stringify({
                    email: f.get("email"),
                    password: f.get("password"),
                    ...(signup ? { name: f.get("name") } : {}),
                  }),
                });
                router.push("/home");
                router.refresh();
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {signup && (
              <label>
                Your name
                <input
                  name="name"
                  autoComplete="name"
                  placeholder="What should we call you?"
                  minLength={1}
                  maxLength={80}
                  required
                />
              </label>
            )}
            <label>
              Email address
              <input
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                maxLength={254}
                required
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete={signup ? "new-password" : "current-password"}
                placeholder={
                  signup ? "At least 10 characters" : "Enter your password"
                }
                minLength={signup ? 10 : 1}
                maxLength={128}
                required
              />
            </label>
            <button className="button primary full" disabled={busy}>
              {busy ? (
                <Spinner />
              ) : signup ? (
                "Create your workspace"
              ) : (
                "Sign in"
              )}
              <ArrowRight size={17} />
            </button>
          </form>
          <p className="auth-switch">
            {signup ? "Already have a workspace?" : "New to AURA?"}{" "}
            <Link href={signup ? "/login" : "/signup"}>
              {signup ? "Sign in" : "Create an account"}
            </Link>
          </p>
          <div className="auth-fineprint">
            <ShieldCheck size={16} />
            <span>
              Your data stays in this AURA installation. AI requests go to your
              configured provider only.
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
