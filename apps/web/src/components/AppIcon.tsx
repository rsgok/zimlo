type AppIconName = "feed" | "tasks" | "plus" | "agents" | "mic" | "stop" | "send" | "check";

interface AppIconProps {
  name: AppIconName;
  className?: string;
}

export function AppIcon({ name, className = "" }: AppIconProps) {
  const common = {
    className: `app-icon ${className}`.trim(),
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  if (name === "feed") {
    return (
      <svg {...common}>
        <rect x="4" y="4" width="16" height="16" rx="4" />
        <path d="M8 9h8M8 13h8M8 17h5" />
      </svg>
    );
  }
  if (name === "tasks") {
    return (
      <svg {...common}>
        <path d="M9 6h10M9 12h10M9 18h10" />
        <path d="m4.5 6 1.2 1.2L7.8 5M4.5 12l1.2 1.2 2.1-2.2M4.5 18l1.2 1.2 2.1-2.2" />
      </svg>
    );
  }
  if (name === "plus") {
    return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
  }
  if (name === "agents") {
    return (
      <svg {...common}>
        <circle cx="9" cy="9" r="3" />
        <circle cx="17" cy="10" r="2.25" />
        <path d="M3.8 19c.5-3.2 2.2-5 5.2-5s4.7 1.8 5.2 5M14.2 15.2c2.9-.8 5.1.5 5.8 3.8" />
      </svg>
    );
  }
  if (name === "mic") {
    return (
      <svg {...common}>
        <rect x="9" y="3.5" width="6" height="11" rx="3" />
        <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3M9 20h6" />
      </svg>
    );
  }
  if (name === "stop") {
    return (
      <svg {...common} fill="currentColor" stroke="none">
        <rect x="7" y="7" width="10" height="10" rx="2" />
      </svg>
    );
  }
  if (name === "send") {
    return (
      <svg {...common}>
        <path d="M5 12h13M13 7l5 5-5 5" />
      </svg>
    );
  }
  return <svg {...common}><path d="m6.5 12 3.4 3.4L18 7.5" /></svg>;
}
