const capabilities = [
  {
    index: "01",
    title: "一页一卡的 Attention Feed",
    copy: "打开就是最值得处理的一张卡。审批、待回复、失败与重要结果优先；普通命令、工具调用和心跳不进入 Feed。",
    facts: ["同任务常规进展自动合并", "已读、已处理、被结果覆盖的内容降权", "标题 3 行、正文 4 行、最多 2 条事实"],
  },
  {
    index: "02",
    title: "Task Profile 是任务真相页",
    copy: "左滑卡片进入对应任务。Header 固定回答：任务是什么、现在什么状态、最新结论是什么、你下一步要做什么。",
    facts: ["紧凑 Timeline，最新动态在上", "Diff、测试、证据和完整结果在这里展开", "过滤原始工具输出与重复完成消息"],
  },
  {
    index: "03",
    title: "手机上继续，而不是回到电脑",
    copy: "审批、直接回复、follow-up 和新任务都在 Zimlo 内完成。输入框以语音优先，草稿会恢复，运行中的追加指令进入可靠队列。",
    facts: ["空闲任务立即发送", "执行中显示排队状态", "重复点击复用同一幂等请求"],
  },
  {
    index: "04",
    title: "Project Agent 成为长期主体",
    copy: "项目拥有名称、头像、简介、默认 Runtime 与跨任务历史；Codex 和 Claude Code 退回到可替换的执行引擎。",
    facts: ["Git identity + 持久 UUID 识别目录迁移", "Codex / Claude Code 与 GUI / CLI 分开标注", "一个 Project 对应一个可编辑 Agent Profile"],
  },
];

const implementationGroups = [
  {
    title: "Feed 内容质量",
    items: ["待处理事项无条件重新浮到当前 Feed", "稳定停留 1 秒才标记已读", "阅读过程中不因已读状态跳卡", "处理成功后卡片留在本轮但解除置顶", "看完后引导新任务或继续历史"],
  },
  {
    title: "手势与移动布局",
    items: ["纵向 scroll-snap 一次聚焦一张卡", "左滑进入 Task Profile", "右滑从当前与历史 Feed 移除", "方向锁与 82px 阈值隔离横纵手势", "底部岛与 iPhone 安全区适配"],
  },
  {
    title: "可靠任务队列",
    items: ["新任务与 follow-up 先写入浏览器 outbox", "断网、重连、退后台后自动重放", "服务端 TaskCommand 持久排队", "失败保留原文并支持原地重试", "本机落盘失败时不关闭输入、不删除草稿"],
  },
  {
    title: "Task Profile",
    items: ["Task Input、状态、结论、下一步固定在 Header", "按设备保存 Timeline 阅读游标", "用户指令、Agent 动态、Diff 与测试结果归一展示", "Agent 精编结果覆盖重复 completed / failed 文本", "底部固定语音优先的继续任务输入"],
  },
  {
    title: "Tasks 与新任务",
    items: ["Tasks 只做搜索、项目筛选、置顶与归档", "组内按创建时间保持稳定", "新任务默认上次选择，否则使用最近项目", "发送后立即出现启动中占位卡", "Project Agent 与 Runtime 信息清晰分层"],
  },
  {
    title: "本地优先与安全",
    items: ["SQLite WAL 保存项目、任务、帖子与队列", "每台设备独立保存已读、移除和 Timeline 游标", "手机审批权限由 Mac 按设备授权", "高风险操作继续要求确认短语", "PWA、离线提示、后台恢复与版本健康检查"],
  },
];

const milestones = [
  ["7736303", "沉浸式 Feed 与 Task Profile", "建立一页一卡、任务 Timeline、新建与继续任务的主骨架。"],
  ["0e40b5b", "项目 Feed 与任务详情", "精简卡片、手势优先、语音输入、历史 Feed 与真实 Diff Review。"],
  ["23e9d1f", "Project Agent 身份", "让项目成为长期主体，加入 Agents 目录、稳定 Git identity 与跨任务 Timeline。"],
  ["b57b255", "移动闭环可靠性", "加入 outbox、PWA、Tasks 置顶归档、离线与后台恢复。"],
  ["0631957", "目标级验收修复", "修复首屏锚点、阅读跳卡、直接回复、待处理重新浮现与可靠落盘反馈。"],
];

export default function Home() {
  return (
    <main>
      <nav className="topbar" aria-label="页面导航">
        <a className="brand" href="#top"><span>Z</span><strong>Zimlo</strong></a>
        <div>
          <a href="#experience">体验</a>
          <a href="#system">系统</a>
          <a href="#evidence">验收</a>
        </div>
        <span className="status"><i /> shipped</span>
      </nav>

      <header className="hero" id="top">
        <div className="hero-copy">
          <p className="kicker">MOBILE CODING AGENT CONTROL CENTER</p>
          <h1>把 Coding Agent<br />装进手机里的<br /><em>注意力系统</em></h1>
          <p className="hero-lede">Zimlo 不再复刻 Codex 的操作界面。它只保留人在移动场景真正需要的事：看见最重要的变化、完成一次决定、继续一项任务。</p>
          <div className="hero-actions">
            <a className="primary" href="#experience">查看完整改造</a>
            <a className="secondary" href="#evidence">查看验收证据</a>
          </div>
        </div>
        <div className="phone-stage" aria-label="Zimlo Feed 概念卡片">
          <div className="orbit orbit-a" />
          <div className="orbit orbit-b" />
          <div className="phone">
            <div className="phone-head"><span className="mini-logo">Z</span><small>实时</small></div>
            <article className="feed-card">
              <div className="feed-meta"><span>需要你处理</span><span>01 / 06</span></div>
              <div className="feed-body">
                <small>股票研究 · 2 分钟前</small>
                <h2>财报结论已更新，等待你确认下一步</h2>
                <p>广告收入增速高于预期，估值模型需要同步调整。</p>
                <ul><li>关键假设上调 8%</li><li>下行风险仍来自资本开支</li></ul>
              </div>
              <div className="next"><span>下一步</span><strong>回复是否更新投资论文</strong></div>
            </article>
            <div className="phone-nav"><b>Feed</b><span>Tasks</span><span>＋</span><span>Agents</span></div>
          </div>
          <span className="swipe-note">左滑 → Task Profile</span>
        </div>
      </header>

      <section className="speed-strip" aria-label="核心体验指标">
        <div><strong>3<small>秒</small></strong><span>知道最需关注什么</span></div>
        <div><strong>10<small>秒</small></strong><span>完成审批、回复或审阅</span></div>
        <div><strong>20<small>秒</small></strong><span>布置一个新任务</span></div>
      </section>

      <section className="section intro" id="experience">
        <div className="section-label">01 / EXPERIENCE</div>
        <div className="section-title">
          <h2>不是缩小版桌面端，<br />是一条完整移动闭环。</h2>
          <p>信息结构围绕人的注意力重排。Feed 决定现在看什么，Task Profile 解释为什么，可靠队列负责把决定送回 Mac。</p>
        </div>
        <div className="capability-grid">
          {capabilities.map((capability) => (
            <article key={capability.index}>
              <span className="cap-index">{capability.index}</span>
              <h3>{capability.title}</h3>
              <p>{capability.copy}</p>
              <ul>{capability.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul>
            </article>
          ))}
        </div>
      </section>

      <section className="journey">
        <div className="journey-copy">
          <p className="kicker">ONE OPEN, ONE LOOP</p>
          <h2>一次打开 Zimlo，<br />完成四步。</h2>
        </div>
        <ol>
          <li><span>00:00</span><div><strong>看到第一张卡</strong><p>未处理审批、待回复和失败永远先于普通结果。</p></div></li>
          <li><span>00:03</span><div><strong>理解结论与影响</strong><p>卡片只保留两条事实和一个明确下一步。</p></div></li>
          <li><span>00:10</span><div><strong>处理或左滑深入</strong><p>卡内直接审批/回复；完整上下文进入 Task Profile。</p></div></li>
          <li><span>00:20</span><div><strong>继续工作</strong><p>追加指令进入持久队列，或使用最近 Project Agent 开新任务。</p></div></li>
        </ol>
      </section>

      <section className="section system" id="system">
        <div className="section-label">02 / SYSTEM</div>
        <div className="section-title">
          <h2>长期主体是 Project Agent。<br />Runtime 只是执行引擎。</h2>
          <p>身份、历史和上下文留在项目里；Codex 与 Claude Code 可以按任务替换，也能准确标记 GUI、CLI 或 Zimlo 托管来源。</p>
        </div>
        <div className="model-map" aria-label="Zimlo 产品数据关系">
          <div className="model-primary"><span>LONG-LIVED</span><strong>Project Agent</strong><small>身份 · 项目 · 长期上下文</small></div>
          <div className="model-arrow">→</div>
          <div className="model-column">
            <div><span>WORK UNIT</span><strong>Task</strong><small>一次具体工作</small></div>
            <div><span>READING UNIT</span><strong>Feed Post</strong><small>一条重要动态</small></div>
          </div>
          <div className="model-arrow">←</div>
          <div className="runtime-stack"><span>EXECUTION</span><b>Codex</b><b>Claude Code</b><small>GUI · CLI · Managed</small></div>
        </div>

        <div className="reliability">
          <div>
            <p className="kicker">RELIABILITY PATH</p>
            <h3>指令先可靠保存，<br />再等待网络。</h3>
            <p>手机上的每次创建、follow-up、审批或移出 Feed 都先进入本机 outbox。Bridge 确认前原文不会消失；重连使用同一幂等键恢复。</p>
          </div>
          <ol>
            <li><span>1</span><strong>语音或键盘输入</strong><small>草稿按任务恢复</small></li>
            <li><span>2</span><strong>浏览器 Outbox</strong><small>本机先落盘</small></li>
            <li><span>3</span><strong>加密 Bridge</strong><small>设备身份与权限</small></li>
            <li><span>4</span><strong>TaskCommand Queue</strong><small>排队、执行、失败重试</small></li>
            <li><span>5</span><strong>Codex / Claude Code</strong><small>精确 Session 恢复</small></li>
          </ol>
        </div>
      </section>

      <section className="section worklog">
        <div className="section-label">03 / EVERYTHING SHIPPED</div>
        <div className="section-title">
          <h2>这次具体做了什么。</h2>
          <p>从视觉结构到协议、数据和恢复链路，改造不是一层移动端皮肤，而是一次产品模型与可靠性系统的收敛。</p>
        </div>
        <div className="work-grid">
          {implementationGroups.map((group) => (
            <details key={group.title} open>
              <summary><span>{group.title}</span><i>＋</i></summary>
              <ul>{group.items.map((item) => <li key={item}>{item}</li>)}</ul>
            </details>
          ))}
        </div>
      </section>

      <section className="data-section">
        <div>
          <p className="kicker">LOCAL-FIRST DATA</p>
          <h2>卡片不是一份散落的日志。</h2>
          <p>数据在 Mac 本地按长期对象分层保存。原始 transcript 不复制进 Zimlo；手机只读取已经归属、被筛选和适合行动的内容。</p>
        </div>
        <div className="data-tree">
          <div><strong>Project</strong><span>路径 · Git identity · Agent Profile</span></div>
          <div className="indent"><strong>Session / Task</strong><span>输入 · 状态 · Runtime · Timeline</span></div>
          <div className="indent-2"><strong>Feed Post</strong><span>结论 · 影响 · 事实 · 下一步</span></div>
          <div className="indent-2"><strong>TaskCommand</strong><span>queued → running → completed / failed</span></div>
          <div><strong>Device State</strong><span>已读 · 移除 · Timeline 游标 · 审批权限</span></div>
        </div>
      </section>

      <section className="section evidence" id="evidence">
        <div className="section-label">04 / EVIDENCE</div>
        <div className="section-title">
          <h2>不是“看起来完成”，<br />而是逐项跑过闭环。</h2>
          <p>最后一轮在真实 Bridge 数据和 390 × 844 移动视口中复验，期间额外发现并修复了两个自动化测试无法暴露的首屏问题。</p>
        </div>
        <div className="proof-grid">
          <article className="proof-main"><strong>98</strong><span>自动化测试全部通过</span><small>31 个测试文件</small></article>
          <article><strong>390 × 844</strong><span>真实移动视口</span><small>首卡、左滑、详情、Tasks、新任务</small></article>
          <article><strong>0</strong><span>横向溢出</span><small>安全区与底部操作区已验证</small></article>
          <article><strong>v2</strong><span>Bridge 协议健康</span><small>生产构建已重启</small></article>
        </div>
        <div className="audit-list">
          <div><span>✓</span><p><strong>首张卡可靠出现</strong>修复异步 Snapshot 到达后 scroll-snap 仍锚定“已看完”的问题。</p></div>
          <div><span>✓</span><p><strong>阅读不再跳卡</strong>已读只影响下次打开的分组，不打断当前浏览顺序。</p></div>
          <div><span>✓</span><p><strong>审批不会藏在历史</strong>已读帖子新获得待处理动作时会重新浮到当前 Feed。</p></div>
          <div><span>✓</span><p><strong>发送失败不丢文字</strong>只有 outbox 确认落盘后，输入才进入已提交状态。</p></div>
        </div>

        <div className="commit-timeline">
          {milestones.map(([hash, title, copy]) => (
            <article key={hash}><code>{hash}</code><div><strong>{title}</strong><p>{copy}</p></div></article>
          ))}
        </div>
      </section>

      <section className="closing">
        <p className="kicker">THE NEW ZIMLO</p>
        <h2>电脑负责执行。<br />手机负责注意、决定与继续。</h2>
        <p>这就是 Zimlo 对 Codex 与 Claude Code 的 90% 移动替代：不搬运复杂界面，只接管人真正需要参与的部分。</p>
        <a href="#top">回到顶部 ↑</a>
      </section>

      <footer><span>ZIMLO · MOBILE ATTENTION SYSTEM</span><span>Built and verified · 2026</span></footer>
    </main>
  );
}
