type AppIconName = "feed" | "tasks" | "plus" | "conversation" | "agents" | "mic" | "stop" | "send" | "check" | "arrow-left" | "arrow-right" | "arrow-up" | "paperclip" | "close" | "refresh" | "device" | "chevron-down";

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
  if (name === "conversation") {
    return <svg {...common} strokeWidth={1.65}>
      <path d="M6 3.5h5.5A3.5 3.5 0 0 1 15 7v1a3.5 3.5 0 0 1-3.5 3.5H8l-3.5 2.6v-2.9A3.5 3.5 0 0 1 2.5 8V7A3.5 3.5 0 0 1 6 3.5Z" />
      <path d="M12.5 12H18a3.5 3.5 0 0 1 3.5 3.5v1A3.5 3.5 0 0 1 18 20h-.5v2.5L14 20h-1.5A3.5 3.5 0 0 1 9 16.5v-1a3.5 3.5 0 0 1 3.5-3.5Z" />
    </svg>;
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
  if (name === "arrow-left") {
    return <svg {...common}><path d="M19 12H5M11 6l-6 6 6 6" /></svg>;
  }
  if (name === "arrow-right") {
    return <svg {...common}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
  }
  if (name === "arrow-up") {
    return <svg {...common}><path d="M12 19V5M6 11l6-6 6 6" /></svg>;
  }
  if (name === "paperclip") {
    return <svg {...common}><path d="m8.7 12.8 6.5-6.5a3.2 3.2 0 1 1 4.5 4.5l-8.2 8.1a5 5 0 0 1-7.1-7l7.9-7.9" /></svg>;
  }
  if (name === "close") {
    return <svg {...common}><path d="m7 7 10 10M17 7 7 17" /></svg>;
  }
  if (name === "refresh") {
    return <svg {...common}><path d="M19 7v5h-5M5 17v-5h5" /><path d="M17.4 9A6 6 0 0 0 6.2 7.5L5 9M6.6 15A6 6 0 0 0 17.8 16.5L19 15" /></svg>;
  }
  if (name === "device") {
    return <svg {...common}><rect x="7" y="3" width="10" height="18" rx="2.5" /><path d="M10.5 6h3M11 18h2" /></svg>;
  }
  if (name === "chevron-down") {
    return <svg {...common}><path d="m7 10 5 5 5-5" /></svg>;
  }
  return <svg {...common}><path d="m6.5 12 3.4 3.4L18 7.5" /></svg>;
}
