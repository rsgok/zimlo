import Foundation

extension AppModel {
    func captureHostIncrementalState(hostId: String, messageType: String) {
        var local = hostSnapshots[hostId] ?? scoped(.empty, hostId: hostId)
        local.host = local.host ?? bridge.hosts.first(where: { $0.id == hostId })?.host
        local.projects = snapshot.projects.filter { $0.hostId == hostId }
        local.sessions = snapshot.sessions.filter { $0.hostId == hostId }
        local.posts = snapshot.posts.filter { $0.hostId == hostId }
        local.tasks = snapshot.tasks.filter { $0.hostId == hostId }
        local.commands = snapshot.commands.filter { $0.hostId == hostId }
        local.materials = snapshot.materials.filter { $0.hostId == hostId }
        local.workspaces = snapshot.workspaces.filter { $0.hostId == hostId }
        local.actions = snapshot.actions.filter { $0.hostId == hostId }
        let sessionIds = Set(local.sessions.map(\.id))
        local.taskPreferences = snapshot.taskPreferences.filter { $0.hostId == hostId }
        local.trustPolicies = snapshot.trustPolicies.filter { $0.hostId == hostId }
        local.trustAudit = snapshot.trustAudit.filter { $0.hostId == hostId }
        local.seenPostIds = snapshot.seenPostIds
        local.dismissedFeedItemIds = snapshot.dismissedFeedItemIds
        local.taskTimelineCursors = snapshot.taskTimelineCursors.filter { sessionIds.contains($0.key) }
        if messageType == "user.profile.updated" { local.userProfile = snapshot.userProfile }
        if messageType == "notification.settings.updated" { local.notificationSettings = snapshot.notificationSettings }
        if messageType == "notification.device.updated" { local.pushDevices = snapshot.pushDevices }
        if messageType == "lan.approvals.changed" { local.lanApprovalsEnabled = snapshot.lanApprovalsEnabled }
        hostSnapshots[hostId] = local
    }

    func scoped(_ value: Snapshot, hostId: String) -> Snapshot {
        var value = value
        value.host = value.host ?? bridge.hosts.first(where: { $0.id == hostId })?.host
        value.projects = value.projects.map { item in var item = item; item.hostId = hostId; return item }
        value.sessions = value.sessions.map { item in var item = item; item.hostId = hostId; return item }
        value.posts = value.posts.map { item in var item = item; item.hostId = hostId; return item }
        value.tasks = value.tasks.map { item in var item = item; item.hostId = hostId; return item }
        value.commands = value.commands.map { item in var item = item; item.hostId = hostId; return item }
        value.materials = value.materials.map { item in var item = item; item.hostId = hostId; return item }
        value.workspaces = value.workspaces.map { item in var item = item; item.hostId = hostId; return item }
        value.actions = value.actions.map { item in var item = item; item.hostId = hostId; return item }
        value.taskPreferences = value.taskPreferences.map { item in var item = item; item.hostId = hostId; return item }
        value.trustPolicies = value.trustPolicies.map { item in var item = item; item.hostId = hostId; return item }
        value.trustAudit = value.trustAudit.map { item in var item = item; item.hostId = hostId; return item }
        return value
    }

    func mergeHostSnapshots() -> Snapshot {
        let values = hostSnapshots.values.sorted {
            ($0.host?.lastSeenAt ?? "") > ($1.host?.lastSeenAt ?? "")
        }
        guard let primary = values.first else { return snapshot }
        let newestProfile = values.max { $0.userProfile.updatedAt < $1.userProfile.updatedAt }?.userProfile ?? primary.userProfile
        let newestNotifications = values.max { $0.notificationSettings.updatedAt < $1.notificationSettings.updatedAt }?.notificationSettings ?? primary.notificationSettings
        func unique(_ values: [String]) -> [String] { Array(Set(values)).sorted() }
        let cursors = values.reduce(into: [String: String]()) { result, value in
            result.merge(value.taskTimelineCursors) { _, incoming in incoming }
        }
        return Snapshot(
            host: primary.host,
            userProfile: newestProfile,
            projects: values.flatMap(\.projects),
            sessions: values.flatMap(\.sessions),
            posts: values.flatMap(\.posts).sorted { $0.createdAt > $1.createdAt },
            tasks: values.flatMap(\.tasks),
            commands: values.flatMap(\.commands),
            materials: values.flatMap(\.materials),
            workspaces: values.flatMap(\.workspaces),
            seenPostIds: unique(values.flatMap(\.seenPostIds)),
            dismissedFeedItemIds: unique(values.flatMap(\.dismissedFeedItemIds)),
            taskTimelineCursors: cursors,
            taskPreferences: values.flatMap(\.taskPreferences),
            actions: values.flatMap(\.actions),
            trustPolicies: values.flatMap(\.trustPolicies),
            trustAudit: values.flatMap(\.trustAudit),
            notificationSettings: newestNotifications,
            pushDevices: values.flatMap(\.pushDevices),
            features: FeatureCapabilities(
                projectTrustPolicy: values.contains { $0.features.projectTrustPolicy },
                pushNotifications: values.contains { $0.features.pushNotifications },
                remoteSync: values.contains { $0.features.remoteSync },
                multiHost: true
            ),
            sequence: values.map(\.sequence).max() ?? 0,
            lanApprovalsEnabled: values.contains { $0.lanApprovalsEnabled },
            trustManagementEnabled: values.contains { $0.trustManagementEnabled }
        )
    }

}
