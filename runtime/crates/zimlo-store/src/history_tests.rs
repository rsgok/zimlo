use super::{HistoryQuery, search};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
fn fixture() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    crate::initialize_current_schema(&db).unwrap();
    crate::set_metadata(&db, "host_identity_v1", "history-host").unwrap();
    db
}
fn query() -> HistoryQuery {
    serde_json::from_value(json!({"requestId":"request", "limit":30})).unwrap()
}
fn post(db: &Connection, id: &str, title: &str, date: &str, source: &str, content: Value) {
    db.execute("INSERT INTO feed_posts(id,task_id,run_id,agent_id,kind,title,body,dedupe_key,source,created_at,content_json) VALUES(?1,'task','run','agent','result',?2,'A useful conclusion',?1,?3,?4,?5)", params![id,title,source,date,content.to_string()]).unwrap();
}
#[test]
fn history_pages_past_live_window_with_stable_ties_and_bound_cursors() {
    let db = fixture();
    for index in 0..235 {
        post(
            &db,
            &format!("p-{index:04}"),
            "Result",
            "2026-09-01T00:00:00.000Z",
            "agent",
            json!({}),
        );
    }
    post(
        &db,
        "private-user",
        "User prompt",
        "2026-09-02",
        "user",
        json!({}),
    );
    let mut q = query();
    let mut ids = std::collections::HashSet::new();
    let first = search(&db, &q).unwrap();
    let cursor = first["nextCursor"].as_str().unwrap().to_owned();
    loop {
        let page = search(&db, &q).unwrap();
        for item in page["items"].as_array().unwrap() {
            assert!(ids.insert(item["id"].as_str().unwrap().to_owned()));
        }
        let Some(cursor) = page["nextCursor"].as_str() else {
            break;
        };
        q.cursor = Some(cursor.into());
    }
    assert_eq!(ids.len(), 235);
    assert!(!ids.contains("post:private-user"));
    q.cursor = Some(cursor);
    q.query = "another search".into();
    assert!(search(&db, &q).is_err());
    q.query = String::new();
    crate::set_metadata(&db, "host_identity_v1", "other-host").unwrap();
    assert!(search(&db, &q).is_err());
}
#[test]
fn history_escapes_wildcards_and_does_not_export_material_paths() {
    let db = fixture();
    post(
        &db,
        "literal",
        "100%_done",
        "2026-09-01",
        "agent",
        json!({"content":{"type":"document","materialId":"output"}}),
    );
    post(
        &db,
        "other",
        "100AAAAdone",
        "2026-09-01",
        "agent",
        json!({}),
    );
    db.execute("INSERT INTO materials(id,kind,name,mime_type,size_bytes,sha256,origin,status,local_path,created_at,error) VALUES('output','document','report.md','text/markdown',10,'digest','agent','ready','/private/secret','2026-08-01','failure at /private/secret')",[]).unwrap();
    let mut q = query();
    q.query = "%_".into();
    let page = search(&db, &q).unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["materials"][0]["sha256"], "digest");
    assert!(!page.to_string().contains("/private/secret"));
    q.query = String::new();
    q.kind = "document".into();
    let page = search(&db, &q).unwrap();
    assert_eq!(page["items"][0]["materialId"], "output");
    let links: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM history_material_links WHERE material_id='output'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(links, 1);
    db.execute(
        "UPDATE feed_posts SET content_json='{}' WHERE id='literal'",
        [],
    )
    .unwrap();
    let links: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM history_material_links WHERE material_id='output'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(links, 0);
}
#[test]
fn history_rejects_invalid_bounds_and_filters() {
    let db = fixture();
    let mut q = query();
    q.limit = 101;
    assert!(search(&db, &q).is_err());
    q.limit = 30;
    q.kind = "raw_prompt".into();
    assert!(search(&db, &q).is_err());
}
