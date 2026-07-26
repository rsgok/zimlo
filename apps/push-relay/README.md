# Zimlo Push Relay

隐私最小化的 APNs 转发服务。它只持久化 APNs device token、随机 endpoint、设备 X25519 公钥、启用状态和时间戳；不接收或保存任务标题、提示词、代码、结果正文。

通知正文默认是通用文案。任务路由由 Mac 使用设备公钥加密，Relay 只能原样转发；App 打开后仍向 Mac Bridge 获取最新状态。

## 本地检查

需要 Node.js 24+：

```bash
pnpm install
pnpm --filter @zimlo/push-relay typecheck
pnpm --filter @zimlo/push-relay build
```

服务启动需要以下变量：

```text
ZIMLO_PUSH_REGISTRATION_SECRET     iOS 注册 endpoint 的 Bearer secret
ZIMLO_SENDER_PUBLIC_KEY_PEM       验证 Mac 请求签名的 Ed25519 公钥
APNS_PRIVATE_KEY_PEM               Apple .p8 私钥内容
APNS_KEY_ID                        Apple Push Key ID
APNS_TEAM_ID                       Apple Developer Team ID
APNS_TOPIC                         iOS Bundle Identifier
APNS_ENVIRONMENT                   sandbox 或 production
ZIMLO_PUSH_DATABASE                SQLite 路径，默认 /data/push-relay.sqlite
```

为 Mac 生成独立 Ed25519 签名密钥：

```bash
openssl genpkey -algorithm ED25519 -out zimlo-push-sender-private.pem
openssl pkey -in zimlo-push-sender-private.pem -pubout -out zimlo-push-sender-public.pem
```

Mac Bridge 使用：

```text
ZIMLO_PUSH_RELAY_URL=https://<your-relay>.fly.dev
ZIMLO_PUSH_RELAY_PRIVATE_KEY_PEM=<private PEM>
```

Relay 使用对应的 `ZIMLO_SENDER_PUBLIC_KEY_PEM`。这些密钥只用于 Mac → Relay 请求签名，不是设备路由加密密钥。

## Fly.io 部署

从仓库根目录执行，先将 `apps/push-relay/fly.toml` 中的 app 名称改成自己唯一的 Fly app：

```bash
fly volumes create zimlo_push_data --region nrt --size 1 --config apps/push-relay/fly.toml
fly secrets set \
  ZIMLO_PUSH_REGISTRATION_SECRET='...' \
  ZIMLO_SENDER_PUBLIC_KEY_PEM='...' \
  APNS_PRIVATE_KEY_PEM='...' \
  APNS_KEY_ID='...' \
  APNS_TEAM_ID='...' \
  APNS_TOPIC='com.example.zimlo' \
  APNS_ENVIRONMENT='production' \
  --config apps/push-relay/fly.toml
fly deploy --config apps/push-relay/fly.toml
```

部署后验证：

```bash
curl https://<your-relay>.fly.dev/healthz
```

应返回 `storesContent: false`。APNs 返回 `410` 时 Relay 会停用 endpoint；iPhone token 轮换或重新安装后再次注册会生成/更新当前设备 endpoint。

Relay 不是远程访问隧道。不要给它增加任务正文、Feed 内容、命令执行或 Mac 反向连接能力。
