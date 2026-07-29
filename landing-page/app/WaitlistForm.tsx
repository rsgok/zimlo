"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";

type FormState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

interface WaitlistFormProps {
  /** Coarse signup surface tag stored with the row (hero | beta | privacy). */
  source: string;
  /** Visual tone matching the surrounding section. */
  tone: "dark" | "acid";
}

/**
 * Shared Beta waitlist form. Posts to /api/waitlist, which the worker only
 * exposes when the waitlist gate is on — this component is rendered by the
 * page exclusively in that state.
 */
export function WaitlistForm({ source, tone }: WaitlistFormProps) {
  const id = useId();
  const emailId = `${id}-email`;
  const consentId = `${id}-consent`;
  const messageId = `${id}-message`;

  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState(""); // honeypot — must stay empty
  // Client-side render timestamp for the server's minimum-dwell check. A ref
  // keeps it out of SSR markup and avoids a re-render when it is stamped.
  const startedAtRef = useRef(0);
  const [state, setState] = useState<FormState>({ status: "idle" });

  useEffect(() => {
    startedAtRef.current = Date.now();
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, consent, source, website, startedAt: startedAtRef.current }),
      });
      const data: unknown = await response.json().catch(() => null);
      const message = data && typeof data === "object"
        ? (data as Record<string, unknown>).message ?? (data as Record<string, unknown>).error
        : null;
      if (response.ok && typeof message === "string") {
        setState({ status: "success", message });
      } else {
        setState({
          status: "error",
          message: typeof message === "string" ? message : "Something went wrong. Please try again.",
        });
      }
    } catch {
      setState({ status: "error", message: "Network error. Check your connection and try again." });
    }
  }

  if (state.status === "success") {
    return (
      <p className={`waitlist-success waitlist-success--${tone}`} role="status" data-waitlist-form={source}>
        <span aria-hidden="true">✓</span> {state.message}
      </p>
    );
  }

  const submitting = state.status === "submitting";

  return (
    <form
      className={`waitlist-form waitlist-form--${tone}`}
      onSubmit={(event) => void onSubmit(event)}
      aria-busy={submitting}
      data-waitlist-form={source}
      noValidate
    >
      <div className="waitlist-field-row">
        <label className="visually-hidden" htmlFor={emailId}>Email address</label>
        <input
          id={emailId}
          className="waitlist-input"
          type="email"
          name="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-describedby={state.status === "error" ? messageId : undefined}
          disabled={submitting}
        />
        <button className="button button--primary waitlist-submit" type="submit" disabled={submitting}>
          {submitting ? "Joining…" : "Notify me"}
        </button>
      </div>

      <div className="waitlist-consent">
        <input
          id={consentId}
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
          disabled={submitting}
        />
        <label htmlFor={consentId}>
          Email me once when the Mac Beta opens. No newsletter, nothing else — see the{" "}
          <a href="/privacy">privacy policy</a>.
        </label>
      </div>

      {/* Honeypot: invisible to humans, skipped by keyboards and AT. Bots that
          fill it are silently accepted but never stored. */}
      <div className="waitlist-honeypot" aria-hidden="true">
        <label htmlFor={`${id}-website`}>Website</label>
        <input
          id={`${id}-website`}
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
        />
      </div>

      <p className="waitlist-message" id={messageId} role="alert">
        {state.status === "error" ? state.message : ""}
      </p>
    </form>
  );
}
