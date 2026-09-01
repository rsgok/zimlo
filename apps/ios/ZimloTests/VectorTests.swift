import XCTest
@testable import Zimlo

// 读取 packages/protocol/test-vectors 下的版本化 JSON 用例逐 case 断言，
// 与 apps/web 的 vitest 使用同一组输入与期望；任何语义漂移必须在向量层先对齐。
final class VectorTests: XCTestCase {
    // 测试源码固定在 apps/ios/ZimloTests，由此推导仓库根，不受构建目录影响。
    private var vectorsDirectory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // apps/ios/ZimloTests
            .deletingLastPathComponent() // apps/ios
            .deletingLastPathComponent() // apps
            .deletingLastPathComponent() // repo root
            .appending(path: "packages/protocol/test-vectors")
    }

    private func loadCases(_ file: String) throws -> [[String: Any]] {
        let url = vectorsDirectory.appending(path: file)
        let data = try Data(contentsOf: url)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any], "bad vector root in \(file)")
        return try XCTUnwrap(root["cases"] as? [[String: Any]], "missing cases in \(file)")
    }

    // MARK: feed-merge.json

    func testFeedMergeVectors() throws {
        for (index, testCase) in try loadCases("feed-merge.json").enumerated() {
            let name = testCase["name"] as? String ?? "case \(index)"
            let input = try XCTUnwrap(testCase["input"] as? [String: Any], name)
            let posts = try XCTUnwrap(input["posts"] as? [[String: Any]], name).map(makePost)
            let expected = try XCTUnwrap((testCase["expected"] as? [String: Any])?["merged"] as? [[String: Any]], name)
            let merged = FeedRules.mergeRoutinePosts(posts)
            XCTAssertEqual(merged.count, expected.count, name)
            for (mergedPost, expectedPost) in zip(merged, expected) {
                assertPost(mergedPost, matches: expectedPost, name)
            }
        }
    }

    // MARK: feed-priority.json

    func testFeedPriorityVectors() throws {
        for (index, testCase) in try loadCases("feed-priority.json").enumerated() {
            let name = testCase["name"] as? String ?? "case \(index)"
            let input = try XCTUnwrap(testCase["input"] as? [String: Any], name)
            let expected = try XCTUnwrap(testCase["expected"] as? [String: Any], name)
            if let kind = input["kind"] as? String {
                let needsAction = false
                let covered = FeedRules.isCovered(
                    kind: kind,
                    createdAt: try XCTUnwrap(input["createdAt"] as? String, name),
                    latestOutcomeCreatedAt: input["latestOutcomeCreatedAt"] as? String
                )
                let priority = FeedRules.priority(
                    kind: kind,
                    needsAction: needsAction,
                    covered: covered,
                    unread: input["unread"] as? Bool ?? false
                )
                XCTAssertEqual(covered, expected["covered"] as? Bool, name)
                XCTAssertEqual(priority, expected["priority"] as? Int, name)
            } else {
                struct Item: FeedOrderable {
                    let id: String
                    let priority: Int
                    let createdAt: String
                }
                let items = try XCTUnwrap(input["items"] as? [[String: Any]], name).map {
                    Item(id: $0["id"] as? String ?? "", priority: $0["priority"] as? Int ?? 0, createdAt: $0["createdAt"] as? String ?? "")
                }
                let order = FeedRules.stableSorted(items).map(\.id)
                XCTAssertEqual(order, expected["order"] as? [String], name)
            }
        }
    }

    // MARK: outbox-keys.json

    func testOutboxKeyVectors() throws {
        for (index, testCase) in try loadCases("outbox-keys.json").enumerated() {
            let name = testCase["name"] as? String ?? "case \(index)"
            let input = try XCTUnwrap(testCase["input"] as? [String: Any], name)
            let type = try XCTUnwrap(input["type"] as? String, name)
            var values = input
            values.removeValue(forKey: "type")
            let command = ClientCommand(type: type, values.mapValues(toJSONValue))
            let expectedKey = try XCTUnwrap((testCase["expected"] as? [String: Any])?["key"] as? String, name)
            XCTAssertEqual(SemanticKey.make(command), expectedKey, name)
        }
    }

    // MARK: backoff.json

    func testBackoffVectors() throws {
        for (index, testCase) in try loadCases("backoff.json").enumerated() {
            let name = testCase["name"] as? String ?? "case \(index)"
            let input = try XCTUnwrap(testCase["input"] as? [String: Any], name)
            let attempt = try XCTUnwrap((input["attempt"] as? NSNumber)?.doubleValue, name)
            let randomValue = try XCTUnwrap((input["randomValue"] as? NSNumber)?.doubleValue, name)
            let expected = try XCTUnwrap(((testCase["expected"] as? [String: Any])?["delayMs"] as? NSNumber)?.intValue, name)
            XCTAssertEqual(ReconnectBackoff.delayMs(attempt: attempt, random: { randomValue }), expected, name)
        }
    }

    // MARK: quick-approve.json

    func testQuickApproveVectors() throws {
        for (index, testCase) in try loadCases("quick-approve.json").enumerated() {
            let name = testCase["name"] as? String ?? "case \(index)"
            let input = try XCTUnwrap(testCase["input"] as? [String: Any], name)
            let kind = try XCTUnwrap(input["kind"] as? String, name)
            let decisions = try XCTUnwrap(input["decisions"] as? [[String: Any]], name).enumerated().map { offset, raw in
                Decision(
                    id: "d-\(offset)",
                    label: raw["scope"] as? String ?? "",
                    scope: raw["scope"] as? String ?? "",
                    value: .null,
                    confirmationPhrase: raw["confirmationPhrase"] as? String,
                    risk: raw["risk"] as? String ?? "low"
                )
            }
            let expected = try XCTUnwrap((testCase["expected"] as? [String: Any])?["quickApprovable"] as? Bool, name)
            XCTAssertEqual(QuickApproveRules.isQuickApprovable(kind: kind, decisions: decisions), expected, name)
        }
    }

    // MARK: cancelable-states.json

    func testCancelableStateVectors() throws {
        for (index, testCase) in try loadCases("cancelable-states.json").enumerated() {
            let name = testCase["name"] as? String ?? "case \(index)"
            let input = try XCTUnwrap(testCase["input"] as? [String: Any], name)
            let state = try XCTUnwrap(input["state"] as? String, name)
            let expected = try XCTUnwrap((testCase["expected"] as? [String: Any])?["cancelable"] as? Bool, name)
            XCTAssertEqual(CommandCancelRules.isCancelable(state), expected, name)
        }
    }

    // MARK: - helpers

    private func makePost(_ raw: [String: Any]) -> FeedPost {
        FeedPost(
            id: raw["id"] as? String ?? "",
            projectId: nil,
            taskId: raw["taskId"] as? String ?? "",
            runId: "run",
            agentId: "agent",
            sessionId: raw["sessionId"] as? String,
            kind: raw["kind"] as? String ?? "",
            presentation: CardPresentation(system: "editorial", theme: "ink_classic", layout: "feature", typography: "serif", density: "balanced", mediaPlacement: "none"),
            headline: "",
            takeaway: "",
            highlights: raw["highlights"] as? [String] ?? [],
            blocks: [],
            proof: nil,
            dedupeKey: "",
            source: "test",
            createdAt: raw["createdAt"] as? String ?? ""
        )
    }

    private func assertPost(_ post: FeedPost, matches expected: [String: Any], _ name: String) {
        XCTAssertEqual(post.id, expected["id"] as? String, name)
        XCTAssertEqual(post.kind, expected["kind"] as? String, name)
        XCTAssertEqual(post.taskId, expected["taskId"] as? String, name)
        XCTAssertEqual(post.sessionId, expected["sessionId"] as? String, name)
        XCTAssertEqual(post.createdAt, expected["createdAt"] as? String, name)
        XCTAssertEqual(post.highlights, expected["highlights"] as? [String], name)
    }
}

// JSONSerialization 的 Any 树转成 JSONValue；NSNumber 需先区分布尔与数字。
func toJSONValue(_ value: Any) -> JSONValue {
    if value is NSNull { return .null }
    if let number = value as? NSNumber {
        if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(number.boolValue) }
        return .number(number.doubleValue)
    }
    if let string = value as? String { return .string(string) }
    if let array = value as? [Any] { return .array(array.map(toJSONValue)) }
    if let object = value as? [String: Any] { return .object(object.mapValues(toJSONValue)) }
    return .null
}
