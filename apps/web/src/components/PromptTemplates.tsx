import { useState } from "react";
interface Template { id: string; title: string; text: string }
const key = "zimlo:prompt-templates:v1";
const defaults: Template[] = [
  { id: "review", title: "检查改动", text: "检查当前改动，找出影响正确性和用户体验的问题，给出证据并修复可确认的问题。" },
  { id: "failure", title: "解释失败", text: "定位这次失败的原因，保留已有工作，修复后重新验证，并说明验证结果。" },
  { id: "continue", title: "继续任务", text: "从已完成的进度继续，完成剩余工作；遇到需要我决定的事项时提供清楚的选项。" },
];
function read(): Template[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return Array.isArray(value) && value.every((item) => item && typeof item.id === "string" && typeof item.title === "string" && typeof item.text === "string") ? value.slice(0, 30) : defaults;
  } catch { return defaults; }
}
export function PromptTemplates({ text, onSelect }: { text: string; onSelect: (text: string) => void }) {
  const [templates, setTemplates] = useState(read);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  function persist(next: Template[]) {
    try { localStorage.setItem(key, JSON.stringify(next)); setTemplates(next); setError(null); }
    catch { setError("本机存储不可用，常用指令尚未保存。"); }
  }
  return <details className="prompt-templates"><summary>常用指令</summary>
    <p>选择后填入编辑器，确认目标和内容后再发送。保存在当前浏览器。</p>
    {templates.map((template) => <div key={template.id}><button type="button" onClick={() => onSelect(template.text)}>{template.title}</button><button type="button" aria-label={`删除常用指令 ${template.title}`} onClick={() => persist(templates.filter((item) => item.id !== template.id))}>删除</button></div>)}
    <label>保存当前正文为常用指令<input maxLength={60} value={name} onChange={(event) => setName(event.target.value)} placeholder="名称" /></label>
    <button type="button" disabled={!name.trim() || !text.trim() || text.length > 10_000 || templates.length >= 30} onClick={() => { persist([...templates, { id: crypto.randomUUID(), title: name.trim(), text }]); setName(""); }}>保存</button>
    {error && <p role="alert">{error}</p>}
  </details>;
}
