import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClientCommand, FeedPost, Material, Project, Session } from "@zimlo/protocol";
import { FormattedText } from "./FormattedText";
import { AgentAvatar } from "./UserAvatar";
import { relativeTime, useNow } from "../lib/nowTicker";
import { initialMaterialURL, materialURL } from "../lib/materialAccess";

interface FeedPostViewProps {
  post: FeedPost;
  materials?: Material[] | undefined;
  session: Session | undefined;
  project: Project | undefined;
  onOpenProject: (projectId: string) => void;
  interactionMode?: "swipe" | "desktop";
  historical?: boolean;
  send?: ((command: ClientCommand) => boolean) | undefined;
}

interface MediaPreview {
  kind: "document";
  url: string;
  name: string;
  mimeType: string;
}

export const FeedPostView = memo(function FeedPostView({ post, materials = [], session, project, onOpenProject, interactionMode = "swipe", historical = false, send = () => false }: FeedPostViewProps) {
  const now = useNow();
  const content = post.content ?? { type: "text" as const };
  const [mediaPreview, setMediaPreview] = useState<MediaPreview | null>(null);
  const taskHint = historical ? "历史" : interactionMode === "desktop" ? "打开任务" : "滑动查看任务";

  return (
    <article className={`feed-post post-${post.kind} template-${post.template} content-${content.type}`}>
      <div className="post-topline">
        <button className="post-agent" disabled={!project} onClick={(event) => { event.stopPropagation(); if (project) onOpenProject(project.id); }}>
          {project && <AgentAvatar avatar={project.agentProfile.avatar} className="post-agent-avatar" alt="" />}
          <span>{project?.agentProfile.displayName ?? post.agentId}</span>
        </button>
        <span className="post-time">{relativeTime(post.createdAt, now)}</span>
      </div>

      {content.type !== "text" && <FeedMediaCard post={{ ...post, content }} materials={materials} onPreview={setMediaPreview} send={send} />}
      <div className={`post-copy ${content.type !== "text" ? "post-copy-media" : ""}`}>
        <h2>{post.headline}</h2>
        <div className="post-takeaway"><FormattedText text={post.takeaway} compact /></div>
        {post.highlights.length > 0 && (
          <ul className="post-highlights">
            {post.highlights.slice(0, 2).map((highlight) => <li key={highlight}>{highlight}</li>)}
          </ul>
        )}
      </div>

      <div className="post-footer">
        {(historical || session) && <span className="post-task-hint">{taskHint}</span>}
      </div>
      {mediaPreview && <FeedMediaViewer preview={mediaPreview} onClose={() => setMediaPreview(null)} />}
    </article>
  );
}, (previous, next) =>
  previous.post === next.post
  && previous.materials === next.materials
  && previous.session === next.session
  && previous.project === next.project
  && previous.onOpenProject === next.onOpenProject
  && previous.send === next.send
  && previous.interactionMode === next.interactionMode
  && previous.historical === next.historical,
);

function FeedMediaCard({ post, materials, onPreview, send }: { post: FeedPost; materials: Material[]; onPreview: (preview: MediaPreview) => void; send: (command: ClientCommand) => boolean }) {
  const content = post.content ?? { type: "text" as const };
  const byId = new Map(materials.map((material) => [material.id, material]));
  const asset = (material: Material) => <MaterialAssetURL material={material} send={send} />;
  if (content.type === "image_album") {
    const values = content.materialIds.flatMap((id) => {
      const material = byId.get(id);
      return material?.status === "ready" ? [material] : [];
    });
    return <div className="feed-image-album" aria-label="图片组">
      {values.map((material) => <div
        className="feed-image-preview"
        key={material.id}
      >{asset(material)}</div>)}
      {values.length > 1 && <div className="feed-image-dots" aria-hidden="true">{values.map((material) => <i key={material.id} />)}</div>}
    </div>;
  }
  if (content.type === "video") {
    const material = byId.get(content.materialId);
    const poster = content.posterMaterialId ? byId.get(content.posterMaterialId) : undefined;
    return material?.status === "ready" ? <ResolvedVideo material={material} poster={poster} send={send} /> : <MissingMaterial />;
  }
  if (content.type === "document") {
    const material = byId.get(content.materialId);
    if (!material || material.status !== "ready") return <MissingMaterial />;
    if (material.mimeType.startsWith("text/") || material.mimeType === "application/json") {
      return <ResolvedDocument material={material} send={send} />;
    }
    if (material.kind === "pdf" || material.mimeType === "application/pdf") return <article className="feed-pdf-reader" aria-label={`阅读 ${material.name}`}>
      <MaterialFrame material={material} send={send} />
      <ResolvedPreviewButton material={material} send={send} onPreview={onPreview} />
    </article>;
    return <ResolvedDocumentButton material={material} send={send} summary={content.summary ?? post.takeaway} onPreview={onPreview} />;
  }
  return null;
}

function useResolvedMaterialURL(material: Material, send: (command: ClientCommand) => boolean): string {
  const [url, setURL] = useState(() => initialMaterialURL(material));
  useEffect(() => {
    let active = true;
    void materialURL(material, send).then((value) => {
      if (active) setURL(value);
    }).catch(() => {});
    return () => { active = false; };
  }, [material, send]);
  return url;
}

function MaterialAssetURL({ material, send }: { material: Material; send: (command: ClientCommand) => boolean }) {
  const url = useResolvedMaterialURL(material, send);
  return <img src={url} alt={material.name} loading="lazy" />;
}

function ResolvedVideo({ material, poster, send }: { material: Material; poster?: Material | undefined; send: (command: ClientCommand) => boolean }) {
  const src = useResolvedMaterialURL(material, send);
  const posterURL = poster ? initialMaterialURL(poster) : undefined;
  const [resolvedPoster, setResolvedPoster] = useState(posterURL);
  useEffect(() => {
    if (!poster) { setResolvedPoster(undefined); return; }
    let active = true;
    void materialURL(poster, send).then((value) => { if (active) setResolvedPoster(value); }).catch(() => {});
    return () => { active = false; };
  }, [poster, send]);
  return <InlineFeedVideo src={src} poster={resolvedPoster} name={material.name} />;
}

function ResolvedDocument({ material, send }: { material: Material; send: (command: ClientCommand) => boolean }) {
  const url = useResolvedMaterialURL(material, send);
  return <InlineDocumentReader material={material} url={url} />;
}

function MaterialFrame({ material, send }: { material: Material; send: (command: ClientCommand) => boolean }) {
  const url = useResolvedMaterialURL(material, send);
  return <iframe src={url} title={material.name} />;
}

function ResolvedPreviewButton({ material, send, onPreview }: { material: Material; send: (command: ClientCommand) => boolean; onPreview: (preview: MediaPreview) => void }) {
  const url = useResolvedMaterialURL(material, send);
  return <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => onPreview({ kind: "document", url, name: material.name, mimeType: material.mimeType })}>全屏阅读</button>;
}

function ResolvedDocumentButton({ material, send, summary, onPreview }: { material: Material; send: (command: ClientCommand) => boolean; summary: string; onPreview: (preview: MediaPreview) => void }) {
  const url = useResolvedMaterialURL(material, send);
  return <button type="button" className="feed-document" onPointerDown={(event) => event.stopPropagation()} onClick={() => onPreview({ kind: "document", url, name: material.name, mimeType: material.mimeType })}>
    <span className="feed-document-icon">FILE</span><span><strong>{material.name}</strong><small>{summary}</small></span><span aria-hidden="true">↗</span>
  </button>;
}

function InlineFeedVideo({ src, poster, name }: { src: string; poster?: string | undefined; name: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [paused, setPaused] = useState(true);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && entry.intersectionRatio >= 0.72) {
        void video.play().catch(() => setPaused(true));
      } else {
        video.pause();
      }
    }, { threshold: [0, 0.72] });
    observer.observe(video);
    return () => {
      observer.disconnect();
      video.pause();
    };
  }, [src]);

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => setPaused(true));
    else video.pause();
  };

  return <div className="feed-video-shell">
    <video
      ref={videoRef}
      className="feed-video"
      src={src}
      poster={poster}
      playsInline
      muted
      loop
      preload="metadata"
      onPlay={() => setPaused(false)}
      onPause={() => setPaused(true)}
    />
    <button
      type="button"
      className={`feed-video-toggle ${paused ? "is-paused" : ""}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={toggle}
      aria-label={`${paused ? "播放" : "暂停"}视频：${name}`}
    >{paused && <span aria-hidden="true">▶</span>}</button>
  </div>;
}

function InlineDocumentReader({ material, url }: { material: Material; url: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setContent(null);
    setFailed(false);
    fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then(setContent)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setFailed(true);
      });
    return () => controller.abort();
  }, [url]);

  return <article className="feed-document-reader" aria-label={`阅读 ${material.name}`}>
    <header><span>文档</span><strong>{material.name}</strong></header>
    <div className="feed-document-reader-scroll" tabIndex={0}>
      {content !== null && <FormattedText text={content} />}
      {content === null && !failed && <div className="feed-material-state">正在读取…</div>}
      {failed && <div className="feed-material-state">读取失败，连接恢复后重试</div>}
    </div>
  </article>;
}

function FeedMediaViewer({ preview, onClose }: { preview: MediaPreview; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="feed-media-viewer" role="dialog" aria-modal="true" aria-label={`预览 ${preview.name}`} onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="feed-media-viewer-panel">
        <header><strong>{preview.name}</strong><button type="button" onClick={onClose} aria-label="关闭预览">×</button></header>
        <div className="feed-media-viewer-content">
          <iframe src={preview.url} title={preview.name} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

function MissingMaterial() {
  return <div className="feed-material-missing">物料正在同步，连接 Mac 后会自动显示</div>;
}
