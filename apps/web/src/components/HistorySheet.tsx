import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClientCommand, HistoryEntry, HistoryPage, Host, Material, Project } from "@zimlo/protocol";
import { useModalFocus } from "./useModalFocus";
import { materialURL, releaseMaterialURL } from "../lib/materialAccess";
import "./history.css";

const kinds = [["all", "全部类型"], ["result", "结果"], ["failure", "失败说明"], ["image", "图片"], ["video", "视频"], ["pdf", "PDF"], ["document", "文档"]];
interface Props {
  hosts: Host[]; projects: Project[]; page: HistoryPage | null;
  failure: { requestId: string; message: string } | null;
  send: (command: ClientCommand) => boolean; onOpen: (id: string) => void; onClose: () => void;
}
export function HistorySheet({ hosts, projects, page, failure, send, onOpen, onClose }: Props) {
  const [host, setHost] = useState(hosts[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("");
  const [kind, setKind] = useState("all");
  const [days, setDays] = useState(0);
  const after = useMemo(() => days ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined, [days]);
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ id: string; host: string; more: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sheet = useRef<HTMLElement | null>(null);
  useModalFocus(sheet);
  const load = useCallback((next?: string) => {
    if (timer.current) clearTimeout(timer.current);
    const requestId = crypto.randomUUID();
    pending.current = { id: requestId, host, more: Boolean(next) };
    setBusy(true); setError(null);
    if (!host || !send({ type: "history.search", hostId: host, requestId, query, kind: kind as "all", limit: 30,
      ...(project ? { projectId: project } : {}), ...(after ? { after } : {}), ...(next ? { cursor: next } : {}) })) {
      pending.current = null; setBusy(false); setError("运行设备当前离线，恢复连接后可重新检索。"); return;
    }
    timer.current = setTimeout(() => {
      pending.current = null; setBusy(false); setError("运行设备暂未返回历史成果。请检查连接，或更新运行设备后重试。");
    }, 15_000);
  }, [host, query, kind, project, after, send]);
  useEffect(() => {
    pending.current = null; setItems([]); setMaterials([]); setCursor(null); setError(null); setBusy(true);
    const debounce = setTimeout(() => load(), 300);
    return () => { clearTimeout(debounce); if (timer.current) clearTimeout(timer.current); pending.current = null; };
  }, [load]);
  useEffect(() => {
    const request = pending.current;
    if (!page || !request || page.requestId !== request.id || page.hostId !== request.host) return;
    if (timer.current) clearTimeout(timer.current);
    pending.current = null;
    setItems((previous) => { const base = request.more ? previous : []; const ids = new Set(base.map((item) => item.id)); return [...base, ...page.items.filter((item) => !ids.has(item.id))]; });
    setMaterials((previous) => [...new Map([...(request.more ? previous : []), ...page.materials].map((item) => [item.id, item])).values()]);
    setCursor(page.nextCursor); setBusy(false);
  }, [page]);
  useEffect(() => {
    if (!failure || failure.requestId !== pending.current?.id) return;
    if (timer.current) clearTimeout(timer.current);
    pending.current = null; setError(failure.message); setBusy(false);
  }, [failure]);
  return <div className="history-backdrop" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <section className="history-sheet" role="dialog" aria-modal="true" aria-labelledby="history-title" ref={sheet}>
      <header><h2 id="history-title">历史成果</h2><button onClick={onClose}>完成</button></header>
      <p>检索运行设备保存的结果和文件，包含近期动态之外的历史内容。</p>
      <div className="history-filters">
        <label>运行设备<select value={host} onChange={(event) => { setHost(event.target.value); setProject(""); }}>{hosts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>搜索<input value={query} maxLength={200} placeholder="结论或文件名" onChange={(event) => setQuery(event.target.value)} /></label>
        <label>项目<select value={project} onChange={(event) => setProject(event.target.value)}><option value="">全部项目</option>{projects.filter((item) => !item.hostId || item.hostId === host).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>类型<select value={kind} onChange={(event) => setKind(event.target.value)}>{kinds.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>
        <label>日期<select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={0}>全部时间</option><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option></select></label>
      </div>
      {error && <p role="alert">{error} <button onClick={() => load(cursor ?? undefined)}>重试</button></p>}
      <div aria-busy={busy}>
        {items.map((item) => <article className="history-entry" key={item.id}>
          <h3>{item.title}</h3><small>{item.createdAt.slice(0, 10)} · {kinds.find(([id]) => id === item.kind)?.[1] ?? item.kind}</small>
          <p>{item.summary}</p>
          {item.sessionId && <button onClick={() => { onOpen(item.sessionId!); onClose(); }}>查看任务</button>}
          {materials.filter((material) => item.materialId === material.id || item.materialIds.includes(material.id)).map((material) => <HistoryFile key={material.id} material={material} send={send} />)}
        </article>)}
        {busy && <p role="status">正在检索…</p>}
        {!busy && !error && !items.length && <p>没有匹配的成果，试试其他关键词或筛选条件。</p>}
        {!busy && cursor && <button onClick={() => load(cursor)}>加载更早成果</button>}
      </div>
    </section>
  </div>;
}
function HistoryFile({ material, send }: { material: Material; send: Props["send"] }) {
  const [url, setURL] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lease = useRef<Material | null>(null);
  useEffect(() => () => { if (lease.current) releaseMaterialURL(lease.current); lease.current = null; }, []);
  return <div><small>{Math.ceil(material.sizeBytes / 1024)} KB · 版本 {material.sha256.slice(0, 8)}</small>{url ? <a href={url} download={material.name}>下载 {material.name}</a> : <button disabled={busy || material.status !== "ready"} onClick={async () => {
    setBusy(true); setError(null);
    lease.current = material;
    try { setURL(await materialURL(material, send)); } catch { lease.current = null; setError("文件暂不可用，请检查运行设备后重试。"); } finally { setBusy(false); }
  }}>{busy ? "正在读取…" : material.name}</button>}{error && <span role="alert">{error}</span>}{material.status !== "ready" && <small>文件暂不可用</small>}</div>;
}
