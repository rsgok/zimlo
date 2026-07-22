import { useEffect, useRef, useState } from "react";

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
}

export function VoiceInput({ value, onChange, placeholder, ariaLabel, rows = 2, disabled = false, autoFocus = false, compact = false }: VoiceInputProps) {
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const [listening, setListening] = useState(false);
  const SpeechRecognition = typeof window === "undefined"
    ? undefined
    : (window as VoiceWindow).SpeechRecognition ?? (window as VoiceWindow).webkitSpeechRecognition;
  const supported = Boolean(SpeechRecognition);

  useEffect(() => () => recognition.current?.stop(), []);

  const toggleVoice = () => {
    if (!SpeechRecognition || disabled) return;
    if (listening) return recognition.current?.stop();
    const instance = new SpeechRecognition();
    const base = value.trimEnd();
    instance.lang = navigator.language?.startsWith("zh") ? navigator.language : "zh-CN";
    instance.continuous = false;
    instance.interimResults = true;
    instance.onresult = (event) => {
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
      <button
        type="button"
        className="voice-input-button"
        aria-label={listening ? "停止语音输入" : "开始语音输入"}
        aria-pressed={listening}
        title={supported ? "语音输入" : "当前浏览器不支持网页语音，可使用系统键盘麦克风"}
        disabled={!supported || disabled}
        onClick={toggleVoice}
      >{listening ? "■" : "●"}<span>{listening ? "正在听" : "语音"}</span></button>
      <textarea
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        autoFocus={autoFocus}
        enterKeyHint="send"
      />
    </div>
  );
}
