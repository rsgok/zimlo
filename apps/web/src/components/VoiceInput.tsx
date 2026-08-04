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
  webkit?: {
    messageHandlers?: {
      zimloSpeech?: NativeSpeechHandler;
    };
  };
}

interface NativeSpeechHandler {
  postMessage(message: { type: "start" | "stop"; locale?: string }): void;
}

interface NativeSpeechEvent {
  type: "state" | "result" | "error";
  recording?: boolean;
  text?: string;
  message?: string;
}

const nativeSpeechEventName = "zimlo:native-speech";

export function mergeSpeechTranscript(base: string, transcript: string): string {
  const cleanBase = base.trim();
  const cleanTranscript = transcript.trim();
  return [cleanBase, cleanTranscript].filter(Boolean).join(" ");
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
  singleLine?: boolean;
  /** 提供后 Enter（不含 Shift）提交，并启用 enterKeyHint="send" */
  onSubmit?: (() => void) | undefined;
  onError?: ((message: string) => void) | undefined;
}

export function VoiceInput({ value, onChange, placeholder, ariaLabel, rows = 2, disabled = false, autoFocus = false, compact = false, singleLine = false, onSubmit, onError }: VoiceInputProps) {
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  // 识别期间的基线文本：用户在识别过程中的手动编辑会成为新的基线，
  // 不会被后续的 onresult 覆盖。
  const recognitionBase = useRef("");
  const onChangeRef = useRef(onChange);
  const onErrorRef = useRef(onError);
  const [listening, setListening] = useState(false);
  const voiceWindow = typeof window === "undefined" ? undefined : window as VoiceWindow;
  const SpeechRecognition = voiceWindow?.SpeechRecognition ?? voiceWindow?.webkitSpeechRecognition;
  const nativeSpeech = voiceWindow?.webkit?.messageHandlers?.zimloSpeech;
  const hasNativeSpeech = Boolean(nativeSpeech);
  const supported = Boolean(nativeSpeech ?? SpeechRecognition);

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    if (!nativeSpeech) return () => recognition.current?.stop();

    const receiveNativeSpeech = (event: Event) => {
      const detail = (event as CustomEvent<NativeSpeechEvent>).detail;
      if (!detail) return;
      if (detail.type === "state") {
        setListening(Boolean(detail.recording));
      } else if (detail.type === "result") {
        onChangeRef.current(mergeSpeechTranscript(recognitionBase.current, detail.text ?? ""));
      } else if (detail.type === "error") {
        setListening(false);
        onErrorRef.current?.(detail.message ?? "语音输入失败，文字草稿仍在");
      }
    };

    window.addEventListener(nativeSpeechEventName, receiveNativeSpeech);
    return () => {
      window.removeEventListener(nativeSpeechEventName, receiveNativeSpeech);
      nativeSpeech.postMessage({ type: "stop" });
    };
  }, [hasNativeSpeech]);

  const handleChange = (next: string) => {
    if (listening) recognitionBase.current = next.trim();
    onChange(next);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!onSubmit || event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onSubmit();
  };

  const toggleVoice = () => {
    if (disabled) return;
    if (nativeSpeech) {
      if (listening) {
        nativeSpeech.postMessage({ type: "stop" });
      } else {
        recognitionBase.current = value.trim();
        setListening(true);
        nativeSpeech.postMessage({
          type: "start",
          locale: navigator.language?.startsWith("zh") ? navigator.language : "zh-CN",
        });
      }
      return;
    }
    if (!SpeechRecognition) return;
    if (listening) return recognition.current?.stop();
    const instance = new SpeechRecognition();
    recognitionBase.current = value.trim();
    instance.lang = navigator.language?.startsWith("zh") ? navigator.language : "zh-CN";
    instance.continuous = false;
    instance.interimResults = true;
    instance.onresult = (event) => {
      const transcript = Array.from(event.results).map((result) => result[0]?.transcript ?? "").join("").trim();
      onChange(mergeSpeechTranscript(recognitionBase.current, transcript));
    };
    instance.onend = () => { recognition.current = null; setListening(false); };
    instance.onerror = () => {
      recognition.current = null;
      setListening(false);
      onError?.("语音输入失败，文字草稿仍在");
    };
    recognition.current = instance;
    setListening(true);
    instance.start();
  };

  return (
    <div className={`voice-input ${compact ? "voice-input-compact" : ""} ${listening ? "is-listening" : ""}`}>
      {singleLine ? <input
        type="text"
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        {...(onSubmit ? { enterKeyHint: "send" as const } : {})}
      /> : <textarea
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        autoFocus={autoFocus}
        {...(onSubmit ? { enterKeyHint: "send" as const } : {})}
      />}
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
