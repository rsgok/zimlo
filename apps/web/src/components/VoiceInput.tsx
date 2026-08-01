import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AppIcon } from "./AppIcon";

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface VoiceWindow extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

interface VoiceInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  rows?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  compact?: boolean;
  /** 提供后 Enter（不含 Shift）提交，并启用 enterKeyHint="send" */
  onSubmit?: (() => void) | undefined;
}

export function VoiceInput({ value, onChange, placeholder, ariaLabel, rows = 2, disabled = false, autoFocus = false, compact = false, onSubmit }: VoiceInputProps) {
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  // 识别期间的基线文本：用户在识别过程中的手动编辑会成为新的基线，
  // 不会被后续的 onresult 覆盖。
  const recognitionBase = useRef("");
  const [listening, setListening] = useState(false);
  const SpeechRecognition = typeof window === "undefined"
    ? undefined
    : (window as VoiceWindow).SpeechRecognition ?? (window as VoiceWindow).webkitSpeechRecognition;
  const supported = Boolean(SpeechRecognition);

  useEffect(() => () => recognition.current?.stop(), []);

  const handleChange = (next: string) => {
    if (listening) recognitionBase.current = next;
    onChange(next);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!onSubmit || event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onSubmit();
  };

  const toggleVoice = () => {
    if (!SpeechRecognition || disabled) return;
    if (listening) return recognition.current?.stop();
    const instance = new SpeechRecognition();
    recognitionBase.current = value.trimEnd();
    instance.lang = navigator.language?.startsWith("zh") ? navigator.language : "zh-CN";
    instance.continuous = false;
    instance.interimResults = true;
    instance.onresult = (event) => {
      const base = recognitionBase.current;
      const transcript = Array.from(event.results).map((result) => result[0]?.transcript ?? "").join("").trim();
      onChange([base, transcript].filter(Boolean).join(base ? " " : ""));
    };
    instance.onend = () => { recognition.current = null; setListening(false); };
    instance.onerror = () => { recognition.current = null; setListening(false); };
    recognition.current = instance;
    setListening(true);
    instance.start();
  };

  return (
    <div className={`voice-input ${compact ? "voice-input-compact" : ""} ${listening ? "is-listening" : ""}`}>
      <textarea
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        autoFocus={autoFocus}
        {...(onSubmit ? { enterKeyHint: "send" as const } : {})}
      />
      <button
        type="button"
        className="voice-input-button"
        aria-label={listening ? "停止语音输入" : "开始语音输入"}
        aria-pressed={listening}
        title={supported ? "语音输入" : "当前浏览器不支持网页语音，可使用系统键盘麦克风"}
        disabled={!supported || disabled}
        onClick={toggleVoice}
      >
        <AppIcon name={listening ? "stop" : "mic"} />
        <span>{listening ? "正在听" : "语音"}</span>
      </button>
    </div>
  );
}
