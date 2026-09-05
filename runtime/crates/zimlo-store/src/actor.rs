use super::*;

pub(super) fn run_actor(
    mut connection: Connection,
    receiver: mpsc::Receiver<Command>,
    revision: Arc<AtomicU64>,
    changes: tokio::sync::watch::Sender<u64>,
) {
    while let Ok(command) = receiver.recv() {
        let before = connection.total_changes();
        let old_revision = revision.load(Ordering::Relaxed);
        match command {
            Command::GetMetadata { key, reply } => {
                let _ = reply.send(get_metadata(&connection, &key));
            }
            Command::SetMetadata { key, value, reply } => {
                let _ = reply.send(set_metadata(&connection, &key, &value));
            }
            Command::DeleteMetadata { key, reply } => {
                let result = delete_metadata(&connection, &key);
                if result.is_ok() {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
                let _ = reply.send(result);
            }
            Command::SessionExists { session_id, reply } => {
                let _ = reply.send(session_exists(&connection, &session_id));
            }
            Command::GetSession { session_id, reply } => {
                let _ = reply.send(get_session(&connection, &session_id));
            }
            Command::WorkspacePath {
                workspace_id,
                reply,
            } => {
                let _ = reply.send(workspace_path(&connection, &workspace_id));
            }
            Command::ListSessions { reply } => {
                let _ = reply.send(list_sessions(&connection));
            }
            Command::UpsertSession { session, reply } => {
                let result = upsert_session(&connection, &session);
                if result.is_ok() {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
                let _ = reply.send(result);
            }
            Command::ListEvents {
                session_id,
                limit,
                reply,
            } => {
                let _ = reply.send(list_events(&connection, &session_id, limit));
            }
            Command::InsertEvent { event, reply } => {
                let result = insert_event(&connection, &event);
                if result.as_ref().is_ok_and(|result| result.inserted) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
                let _ = reply.send(result);
            }
            Command::Snapshot { options, reply } => {
                let _ = reply.send(snapshot::build(&connection, &options));
            }
            Command::Discovery(command) => {
                if discovery::execute(&mut connection, command) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
            }
            Command::Action(command) => {
                if actions::execute(&mut connection, command) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
            }
            Command::AgentTool(command) => {
                if agent_tools::execute(&mut connection, command) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
            }
            Command::Device(command) => {
                if devices::execute(&connection, command) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
            }
            Command::Material(command) => {
                if materials::execute(&connection, command) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
            }
            Command::Mutation(command) => {
                if mutations::execute(&mut connection, command) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
            }
            Command::Push(command) => {
                if push::execute(&connection, command) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
            }
            Command::TaskCommand(command) => {
                if task_commands::execute(&mut connection, command) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
            }
            Command::Trust(command) => {
                if trust::execute(&mut connection, command) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
            }
            Command::History(search) => {
                let _ = search
                    .reply
                    .send(history::search(&connection, &search.query));
            }
            Command::Shutdown => break,
        }
        if connection.total_changes() != before || revision.load(Ordering::Relaxed) != old_revision
        {
            if revision.load(Ordering::Relaxed) == old_revision {
                revision.fetch_add(1, Ordering::Relaxed);
            }
            changes.send_replace(revision.load(Ordering::Relaxed));
        }
    }
}
