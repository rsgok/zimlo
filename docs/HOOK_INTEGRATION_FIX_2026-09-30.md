# Codex hook 重复接入修复

已修复源码，并在本机安装、迁移与验证

原配置同时存在三个用户级 hook 和三个插件 hook。Codex 桌面版与 CLI 合并这些来源；命令里的 `--surface gui/cli` 只给 Zimlo 标记来源，无法限制 Codex 加载

现在插件接入优先，两端共用三个 hook：

- SessionStart：Binding Zimlo session
- PreToolUse（仅 request_user_input）：Waiting for Zimlo input
- PermissionRequest：Waiting for Zimlo approval

共享 hook 使用 `--surface auto`，由实际 TTY 与父进程链识别桌面版或 CLI；来源识别最多等待 500ms。没有插件的纯 CLI 安装仍可使用单套用户级 hook

插件激活成功后迁移旧的用户级 Zimlo handler，包含已淘汰的 Stop、PostToolUse、UserPromptSubmit 等事件。迁移保留其他 handler、配置与原文件备份。JSON 损坏或插件激活失败时保留旧 hook。后续 CLI 修复复用插件，不重新添加另一套

安装器也补齐了当前桌面应用内置 Codex CLI 的路径，并在未显式指定其他可执行文件时优先使用它，避免旧 Homebrew CLI 无法解析当前配置而阻止迁移

本机验证：用户级 Zimlo hook 为 0，已启用插件中的 Zimlo hook 为 3；实际执行 CLI 接入修复后仍为 3。桌面接入状态为 ready，CLI 为 shared。已安装并验证签名与二进制一致性的修复 Runtime，保留之前的 Runtime 与指针备份；Bridge 已切换到新二进制并通过协议 v5 健康检查

自动检查通过：TypeScript 全量 462 项测试、Rust 全量 95 项测试、macOS 111 项测试、类型检查、构建、Clippy、Rust 格式与 git diff 检查。另覆盖迁移备份、第三方 handler 保留、重复 CLI 修复、配置损坏、激活失败和不同进程来源识别

Codex hook 信任审核仍由用户在应用设置中完成。关闭旧审核弹窗后重新打开，审核上述三个 Zimlo hook，并新建任务加载更新；现有任务不会动态获得新的插件配置。应用 UI 无法通过当前计算机控制工具直接检查，因此“三项”的本机验证来自实际配置和 CLI 修复结果
