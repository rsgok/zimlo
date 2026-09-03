# Linux 无界面服务器

Linux 版 Zimlo 是一个单独的 Rust 可执行文件加静态资源，不需要 Node.js，也不需要桌面环境。它和服务器上的 Codex/Claude Code 以同一用户运行，通过本地 Unix Socket、hooks 和 transcript 获取任务状态，再主动连接 `cloud.zimlo.app`。服务器无需开放入站端口。

支持 x86_64 和 aarch64 Linux。发布包使用静态 musl Runtime，避免依赖服务器上的特定 glibc 版本。服务托管使用 systemd user service；Codex 与 Zimlo 必须属于同一个 Linux 用户，否则 Zimlo 无法读取对应 session 或安全地执行回复与审批。

## 安装

从 GitHub Actions 或 Release 下载对应架构的 `zimlo-<version>-linux-<arch>.tar.gz`，然后执行：

```bash
tar -xzf zimlo-<version>-linux-<arch>.tar.gz
cd zimlo-<version>-linux-<arch>
./install.sh
```

默认安装到 `~/.local`。如果 `~/.local/bin` 不在 `PATH`，先执行：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

安装器会写入 `~/.config/systemd/user/zimlo.service`，并立即启动服务。它不会使用 `sudo`，也不会改写系统级服务。

接入服务器上的 Codex CLI 并与 iPhone 配对：

```bash
zimlo integrations install --target cli
zimlo pair
zimlo doctor
```

`zimlo pair` 会在终端中显示两分钟有效的二维码和连接码。用 iPhone 上的 Zimlo 扫描即可；手机和服务器无需处在同一局域网。

## 日常管理

```bash
zimlo status
zimlo service status
zimlo logs --follow
zimlo devices list
zimlo service uninstall
```

如果 SSH 退出后 user service 会停止，请让服务器管理员为该账户启用 linger：

```bash
sudo loginctl enable-linger "$USER"
```

Zimlo 本地管理页只监听 `127.0.0.1`。需要查看时执行 `zimlo open` 获取地址，再从个人电脑建立 SSH 隧道：

```bash
ssh -L 4747:127.0.0.1:4747 user@server
```

然后在个人电脑访问 `http://127.0.0.1:4747`。这不是手机远程使用的必要步骤。

## 容器说明

推荐直接安装在运行 Codex 的 Linux 主机用户下。如果 Codex 在容器内运行，Zimlo 也应运行在同一容器或共享相同的用户目录、session 文件、Unix Socket 和进程命名空间；只挂载项目目录并不足以发现和管理 Codex session。

从源码构建 Linux 包需要 Node.js 24、pnpm 10 和 Rust 1.98：

```bash
pnpm install --frozen-lockfile
pnpm runtime:build:linux
```
