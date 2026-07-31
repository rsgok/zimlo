# zimlo-work-report

Zimlo 移动端产品改造的中文工程验收汇报站（单页，`app/page.tsx`），vinext + Next.js 16 + React 19 + Cloudflare Workers。独立子项目，不在 monorepo pnpm workspace 内，使用 npm。

- `npm run build`：构建。`prebuild` 钩子通过 `vitest list --json` 读取实际测试定义，并记录当前 commit 与工作区状态；在 monorepo 外构建时复用已提交的 `app/facts.json`。
- `npm test`：构建并校验渲染后的 HTML；`npm run lint`：ESLint。
- 部署：发布到 OpenAI workspace sites（`zimlo-mobile-attention.wkk99.chatgpt.site`）。
