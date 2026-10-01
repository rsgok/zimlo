use serde_json::{Map, Value, json};

#[derive(Default)]
pub(super) struct SnapshotDelivery {
    pub enabled: bool,
    revision: u64,
    previous: Option<Value>,
}

impl SnapshotDelivery {
    pub fn reset(&mut self, enabled: bool) {
        self.enabled = enabled;
        self.previous = None;
    }

    pub fn message(&mut self, snapshot: Value) -> Value {
        let previous_revision = self.revision.to_string();
        self.revision += 1;
        let revision = self.revision.to_string();
        let full = json!({"type":"session.snapshot", "snapshot": snapshot, "revision":revision,
            "syncCapabilities":{"delta":true,"history":true}});
        let message = self
            .previous
            .as_ref()
            .filter(|previous| self.enabled && previous["host"]["id"] == snapshot["host"]["id"])
            .and_then(|previous| delta(previous, &snapshot, &previous_revision, &revision))
            .filter(|delta| delta.to_string().len() < full.to_string().len())
            .unwrap_or(full);
        self.previous = Some(snapshot);
        message
    }
}

fn collection_key(name: &str) -> Option<&'static str> {
    match name {
        "projects" | "sessions" | "posts" | "materials" | "tasks" | "commands" | "workspaces"
        | "cards" => Some("id"),
        "actions" => Some("actionId"),
        "taskPreferences" => Some("sessionId"),
        _ => None,
    }
}

fn delta(previous: &Value, next: &Value, base: &str, revision: &str) -> Option<Value> {
    let (previous, next_object) = (previous.as_object()?, next.as_object()?);
    let mut replace = Map::new();
    let mut collections = Map::new();
    for (name, value) in next_object {
        if previous.get(name) == Some(value) {
            continue;
        }
        if let Some(key) = collection_key(name)
            && let Some(old) = previous.get(name).and_then(Value::as_array)
            && let Some(new) = value.as_array()
        {
            let old: std::collections::HashMap<&str, &Value> = old
                .iter()
                .map(|item| Some((item[key].as_str()?, item)))
                .collect::<Option<_>>()?;
            let new: std::collections::HashMap<&str, &Value> = new
                .iter()
                .map(|item| Some((item[key].as_str()?, item)))
                .collect::<Option<_>>()?;
            let upsert: Vec<_> = value
                .as_array()?
                .iter()
                .filter(|item| old.get(item[key].as_str().unwrap()).copied() != Some(*item))
                .collect();
            let mut remove: Vec<_> = old
                .keys()
                .filter(|id| !new.contains_key(**id))
                .copied()
                .collect();
            remove.sort_unstable();
            let order: Vec<_> = value.as_array()?.iter().map(|item| &item[key]).collect();
            collections.insert(
                name.clone(),
                json!({"key":key,"upsert":upsert,"remove":remove,"order":order}),
            );
        } else {
            replace.insert(name.clone(), value.clone());
        }
    }
    let removed: Vec<_> = previous
        .keys()
        .filter(|key| !next_object.contains_key(*key))
        .collect();
    Some(
        json!({"type":"snapshot.delta", "hostId":next["host"]["id"], "baseRevision":base,
        "revision":revision,"replace":replace,"collections":collections,"removedFields":removed}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn server_matches_shared_client_delta_vector() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/protocol/test-vectors/snapshot-delta.json"
        )))
        .unwrap();
        let vector = &vectors[0];
        assert_eq!(
            delta(&vector["full"]["snapshot"], &vector["expected"], "1", "2").unwrap(),
            vector["patch"]
        );
    }
    #[test]
    fn legacy_clients_always_receive_full_snapshots_and_reset_recovers_gaps() {
        let value = json!({"host":{"id":"mac"},"posts":[{"id":"a","text":"x".repeat(2000)}]});
        let mut delivery = SnapshotDelivery::default();
        assert_eq!(delivery.message(value.clone())["type"], "session.snapshot");
        assert_eq!(delivery.message(value.clone())["type"], "session.snapshot");
        delivery.enabled = true;
        let mut next = value.clone();
        next["sequence"] = json!(2);
        let patch = delivery.message(next.clone());
        assert_eq!(patch["type"], "snapshot.delta");
        assert_eq!(patch["baseRevision"], "2");
        assert_eq!(patch["replace"]["sequence"], 2);
        delivery.reset(true);
        assert_eq!(delivery.message(next)["type"], "session.snapshot");
    }
    #[test]
    fn collection_delta_preserves_removals_updates_and_order() {
        let a = json!({"host":{"id":"h"},"actions":[{"actionId":"a"},{"actionId":"b"}],"seenPostIds":[]});
        let b = json!({"host":{"id":"h"},"actions":[{"actionId":"b","state":"resolved"},{"actionId":"c"}],"seenPostIds":["p"]});
        let patch = delta(&a, &b, "1", "2").unwrap();
        assert_eq!(patch["collections"]["actions"]["remove"], json!(["a"]));
        assert_eq!(patch["collections"]["actions"]["order"], json!(["b", "c"]));
        assert_eq!(
            patch["collections"]["actions"]["upsert"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(patch["replace"]["seenPostIds"], json!(["p"]));
    }
}
