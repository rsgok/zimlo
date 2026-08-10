import SwiftUI

struct NativeSettingsView: View {
    @ObservedObject var store: NativeAppStore
    @ObservedObject var service: ServiceController
    @State private var showingDevices = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                serviceCard
                HStack(alignment: .top, spacing: 14) {
                    integrationsCard
                    devicesCard
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
                permissionsCard
                maintenanceCard
            }
            .padding(26)
            .frame(maxWidth: 900, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(NativeTheme.paper)
        .navigationTitle("设置")
        .task {
            async let status: Void = { _ = await service.refreshStatus() }()
            async let devices: Void = store.loadDevices()
            _ = await (status, devices)
        }
        .sheet(isPresented: $showingDevices) {
            NativeDevicesSheet(store: store)
        }
    }

    private var serviceCard: some View {
        HStack(spacing: 16) {
            ZStack {
                Circle().fill(serviceColor.opacity(0.14)).frame(width: 52, height: 52)
                Image(systemName: service.state == .ready ? "checkmark.circle.fill" : "bolt.horizontal.circle.fill")
                    .font(.system(size: 24, weight: .bold))
                    .foregroundStyle(serviceColor)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("本地 Bridge").font(.system(size: 16, weight: .bold, design: .rounded))
                Text(service.state.label).font(.system(size: 12, weight: .bold)).foregroundStyle(serviceColor)
                Text(service.menuDetail).font(.system(size: 10.5, weight: .medium)).foregroundStyle(NativeTheme.muted)
            }
            Spacer()
            if service.state != .ready {
                Button("重新连接") { Task { await service.retry() } }
                    .buttonStyle(.borderedProminent).tint(NativeTheme.acid)
                    .disabled(service.controlBusy)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .nativeCard(cornerRadius: 17)
    }

    private var integrationsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Agent 接入").font(.system(size: 14, weight: .bold, design: .rounded))
            ForEach(service.status?.integrations ?? []) { integration in
                HStack(spacing: 10) {
                    Circle().fill(integration.isReady ? NativeTheme.sage : NativeTheme.amber).frame(width: 7, height: 7)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(integration.label).font(.system(size: 11, weight: .bold))
                        Text(integration.detail).font(.system(size: 9.5, weight: .medium)).foregroundStyle(NativeTheme.muted).lineLimit(2)
                    }
                    Spacer()
                }
            }
            if let issue = service.integrationIssue {
                Text(issue.message).font(.system(size: 10, weight: .medium)).foregroundStyle(NativeTheme.coral)
            }
            Spacer(minLength: 0)
            Button(service.integrationBusy ? "正在检查…" : "修复本机接入") {
                Task { await service.installIntegration("all") }
            }
            .buttonStyle(.bordered)
            .disabled(service.integrationBusy)
        }
        .padding(18)
        .frame(maxWidth: .infinity, minHeight: 224, alignment: .topLeading)
        .nativeCard(cornerRadius: 16)
    }

    private var devicesCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("手机连接").font(.system(size: 14, weight: .bold, design: .rounded))
                Spacer()
                Text("\(store.devices.count) 台")
                    .font(.system(size: 10, weight: .bold)).foregroundStyle(NativeTheme.muted)
            }
            if let image = service.pairingImage {
                Image(nsImage: image)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: 112, height: 112)
                    .padding(6)
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                Text("用 iPhone Zimlo 扫码连接")
                    .font(.system(size: 9.5, weight: .medium)).foregroundStyle(NativeTheme.muted)
            } else {
                Text("手机与 Mac 通过加密通道同步任务。生成二维码后，两分钟内完成扫描。")
                    .font(.system(size: 10.5, weight: .medium)).foregroundStyle(NativeTheme.ink.opacity(0.66)).lineSpacing(3)
            }
            if let issue = service.pairingIssue {
                Text(issue.message).font(.system(size: 10, weight: .medium)).foregroundStyle(NativeTheme.coral)
            }
            HStack(spacing: 8) {
                Button("管理设备") { showingDevices = true }
                    .buttonStyle(.bordered)
                    .disabled(store.devices.isEmpty)
                Spacer()
                if service.pairingImage == nil {
                    Button(service.pairingBusy ? "正在生成…" : "连接新手机") {
                        Task { await service.createPairing() }
                    }
                    .buttonStyle(.borderedProminent).tint(NativeTheme.acid)
                    .disabled(service.pairingBusy || !service.isReady)
                } else {
                    Button(service.pairingBusy ? "正在取消…" : "取消连接", role: .destructive) {
                        Task { await service.cancelPairing() }
                    }
                    .buttonStyle(.bordered)
                    .disabled(service.pairingBusy)
                }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, minHeight: 224, alignment: .topLeading)
        .nativeCard(cornerRadius: 16)
    }

    private var permissionsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("权限边界").font(.system(size: 14, weight: .bold, design: .rounded))
            HStack(spacing: 18) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("允许局域网审批").font(.system(size: 11.5, weight: .bold))
                    Text("仅对已配对、已授权的设备生效；高风险操作仍会再次确认。")
                        .font(.system(size: 9.5, weight: .medium)).foregroundStyle(NativeTheme.muted)
                }
                Spacer(minLength: 0)
                Toggle("允许局域网审批", isOn: Binding(
                    get: { store.snapshot.lanApprovalsEnabled },
                    set: { enabled in Task { await store.setLANApprovals(enabled) } }
                ))
                .labelsHidden()
                .toggleStyle(.switch)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .nativeCard(cornerRadius: 16)
    }

    private var maintenanceCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("维护").font(.system(size: 14, weight: .bold, design: .rounded))
            HStack(spacing: 10) {
                Button("打开日志", systemImage: "doc.text") { service.openLog() }
                Button("打开数据目录", systemImage: "folder") { service.openServiceDirectory() }
                Button("检查更新", systemImage: "arrow.down.circle") {
                    if !AppModel.shared.updates.checkForUpdates() {
                        store.showNotice("当前构建未配置在线更新", tone: .neutral)
                    }
                }
                Spacer()
                Button("停止后台服务", role: .destructive) { Task { await service.stopService() } }
                    .disabled(service.controlBusy)
            }
            .buttonStyle(.bordered)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .nativeCard(cornerRadius: 16)
    }

    private var serviceColor: Color {
        switch service.state {
        case .ready: NativeTheme.sage
        case .degraded, .starting, .stopping: NativeTheme.amber
        case .manualStopped, .unavailable: NativeTheme.coral
        }
    }
}

private struct NativeDevicesSheet: View {
    @ObservedObject var store: NativeAppStore
    @Environment(\.dismiss) private var dismiss
    @State private var pendingRemoval: NativeDevice?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("已连接设备")
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                    Text("移除后，这台设备会立即断开，需要重新扫码才能连接。")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(NativeTheme.muted)
                }
                Spacer()
                Button("完成") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            .padding(22)

            Divider().opacity(0.45)

            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(store.devices) { device in
                        HStack(spacing: 13) {
                            ZStack {
                                RoundedRectangle(cornerRadius: 11, style: .continuous)
                                    .fill(NativeTheme.acidSoft)
                                Image(systemName: "iphone.gen3")
                                    .font(.system(size: 18, weight: .semibold))
                                    .foregroundStyle(NativeTheme.acid)
                            }
                            .frame(width: 42, height: 42)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(device.name)
                                    .font(.system(size: 13, weight: .bold))
                                Text("最近连接：\(device.lastSeenAt.zimloDate.formatted(.relative(presentation: .named)))")
                                    .font(.system(size: 10.5, weight: .medium))
                                    .foregroundStyle(NativeTheme.muted)
                            }
                            Spacer()
                            Button("移除", role: .destructive) { pendingRemoval = device }
                                .buttonStyle(.bordered)
                        }
                        .padding(14)
                        .nativeCard(cornerRadius: 14)
                    }
                }
                .padding(18)
            }
        }
        .frame(width: 540, height: 470)
        .background(NativeTheme.paper)
        .task { await store.loadDevices() }
        .confirmationDialog(
            "移除 \(pendingRemoval?.name ?? "这台设备")？",
            isPresented: Binding(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let device = pendingRemoval {
                Button("移除设备", role: .destructive) {
                    pendingRemoval = nil
                    Task { _ = await store.revokeDevice(device) }
                }
            }
            Button("取消", role: .cancel) { pendingRemoval = nil }
        }
    }
}
