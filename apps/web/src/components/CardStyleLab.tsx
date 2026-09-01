import "./cardStyleLab.css";
import { EMPTY_CAPABILITIES, type FeedPost, type Session } from "@zimlo/protocol";
import { FeedPostView } from "./FeedPostView";

const MOCK_CARD = {
  agent: "Zimlo",
  time: "刚刚",
  eyebrow: "结果 · SYSTEM HEALTH",
  headline: "通知链路现在会自己恢复",
  takeaway: "从系统设置返回后，Zimlo 会立即读取最新权限；用户偏好保持不变，也不再需要重启应用。",
  signals: [
    { label: "状态同步", detail: "系统设置返回后立即刷新", value: "实时" },
    { label: "回归验证", detail: "通知授权与偏好边界已覆盖", value: "87 / 87" },
  ],
  proof: "macOS 通知测试与完整构建通过",
  action: "打开任务",
} as const;

function ZimloMark() {
  return <span className="card-lab-mark" aria-hidden="true">Z</span>;
}

const MOCK_SESSION: Session = {
  id: "card-lab-session", provider: "codex", surface: "gui", providerSessionId: "card-lab-run",
  title: MOCK_CARD.headline, cwd: null, transcriptPath: null, status: "idle",
  lastActivityAt: "2026-09-01T09:00:00.000Z", createdAt: "2026-09-01T09:00:00.000Z",
  activePid: null, processStartedAt: null, tty: null, correlationUncertain: false,
  capabilities: EMPTY_CAPABILITIES,
};

const BASE_POST: Omit<FeedPost, "id" | "dedupeKey" | "presentation" | "blocks"> = {
  taskId: "card-lab-task", runId: MOCK_SESSION.providerSessionId, agentId: MOCK_CARD.agent,
  sessionId: MOCK_SESSION.id, kind: "result", headline: MOCK_CARD.headline,
  takeaway: MOCK_CARD.takeaway, highlights: [], proof: MOCK_CARD.proof,
  content: { type: "text" }, source: "agent", createdAt: MOCK_SESSION.createdAt,
};

const EDITORIAL_POST: FeedPost = {
  ...BASE_POST, id: "card-lab-editorial", dedupeKey: "card-lab-editorial",
  presentation: { system: "editorial", theme: "ink_classic", layout: "field_note", typography: "serif", density: "balanced", mediaPlacement: "none" },
  blocks: MOCK_CARD.signals.map((signal) => ({ type: "fact" as const, ...signal })),
};

const SWISS_POST: FeedPost = {
  ...BASE_POST, id: "card-lab-swiss", dedupeKey: "card-lab-swiss",
  presentation: { system: "swiss", theme: "lemon_green", layout: "metric_grid", typography: "sans", density: "balanced", mediaPlacement: "none" },
  blocks: [
    { type: "metric", label: "TESTS", value: "87", caption: "全部通过" },
    { type: "metric", label: "RESTARTS", value: "0", caption: "无需重启" },
  ],
};

function ProductionCard({ post }: { post: FeedPost }) {
  return <div className="card-lab-production-card"><FeedPostView
    post={post}
    session={MOCK_SESSION}
    project={undefined}
    interactionMode="desktop"
    onOpenProject={() => {}}
  /></div>;
}

function EditorialCard() {
  return <ProductionCard post={EDITORIAL_POST} />;
}

function SwissCard() {
  return <ProductionCard post={SWISS_POST} />;
}

function EditorialMediaCard() {
  return (
    <article className="card-lab-card card-lab-editorial-media" aria-labelledby="editorial-media-title">
      <img
        className="card-lab-media-image"
        src="/card-lab/editorial-workspace.jpg"
        alt="暖色自然光下摆放着电脑、手机和笔记本的工作台"
      />
      <header className="editorial-media-header">
        <div><ZimloMark /><strong>{MOCK_CARD.agent}</strong></div>
        <span>FIELD NOTE / 01</span>
      </header>
      <div className="editorial-media-copy">
        <p>{MOCK_CARD.eyebrow}</p>
        <h2 id="editorial-media-title">通知恢复，<br />不必重启</h2>
        <span>系统设置返回后，状态立即同步。</span>
      </div>
      <footer className="editorial-media-footer">
        <span><i aria-hidden="true" /> VERIFIED</span>
        <strong>87 项测试通过</strong>
        <b>{MOCK_CARD.action} →</b>
      </footer>
    </article>
  );
}

function SwissMediaCard() {
  return (
    <article className="card-lab-card card-lab-swiss-media" aria-labelledby="swiss-media-title">
      <header className="swiss-media-header">
        <span>ZIMLO / CONNECTION</span>
        <span>VERIFIED—01</span>
      </header>
      <div className="swiss-media-well">
        <img
          className="card-lab-media-image"
          src="/card-lab/swiss-connection.jpg"
          alt="俯视视角下由线缆连接的电脑和手机"
        />
        <span>ENCRYPTED LINK</span>
      </div>
      <div className="swiss-media-story">
        <div>
          <p>RESULT / SYSTEM</p>
          <h2 id="swiss-media-title">连接状态<br />已经同步</h2>
        </div>
        <div className="swiss-media-score">
          <span>TESTS</span>
          <strong>87</strong>
          <small>PASS</small>
        </div>
      </div>
      <footer className="swiss-footer">
        <span>STATE / VERIFIED BY SYSTEM</span>
        <strong>{MOCK_CARD.action} ↗</strong>
      </footer>
    </article>
  );
}

interface CardStyleLabProps {
  mode?: "all" | "media" | "text";
}

export function CardStyleLab({ mode = "all" }: CardStyleLabProps) {
  const mediaOnly = mode === "media";
  const textOnly = mode === "text";
  return (
    <main className="card-style-lab">
      <header className="card-style-lab-header">
        <div>
          <p>{mediaOnly ? "IMAGE-LED / 02" : textOnly ? "TEXT-LED / 01" : "DESIGN EXPLORATION / 01"}</p>
          <h1>{mediaOnly ? "两套 Zimlo 带图卡片" : textOnly ? "两套 Zimlo 无图卡片" : "两套 Zimlo 视觉系统"}</h1>
        </div>
        <p>{mediaOnly ? "图片承担现场感，结构化文字仍由卡片组件渲染。" : textOnly ? "只用排版、色彩与结构表达同一份 FeedPost。" : "同一份 Mock FeedPost，只改变信息编排与视觉语言。"}</p>
      </header>

      {!mediaOnly && (
        <div className="card-style-lab-grid">
          <section className="card-style-lab-option">
            <header><div><strong>01</strong><h2>Zimlo Editorial</h2></div><p>叙事、判断、结果总结</p></header>
            <EditorialCard />
          </section>

          <section className="card-style-lab-option">
            <header><div><strong>02</strong><h2>Zimlo Swiss</h2></div><p>证据、进展、结构化信息</p></header>
            <SwissCard />
          </section>
        </div>
      )}

      {mode === "all" && (
        <header className="card-style-lab-section-header" id="media-cards">
          <div>
            <p>IMAGE-LED / 02</p>
            <h2>带图版本</h2>
          </div>
          <p>图片承担现场感，结构化文字仍由卡片组件渲染。</p>
        </header>
      )}

      {!textOnly && (
        <div className="card-style-lab-grid">
          <section className="card-style-lab-option">
            <header><div><strong>03</strong><h2>Editorial · Image-led</h2></div><p>安静区压字、照片主导</p></header>
            <EditorialMediaCard />
          </section>

          <section className="card-style-lab-option">
            <header><div><strong>04</strong><h2>Swiss · Evidence image</h2></div><p>证据图像、指标编排</p></header>
            <SwissMediaCard />
          </section>
        </div>
      )}
    </main>
  );
}
