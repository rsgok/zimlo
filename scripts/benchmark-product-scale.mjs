import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, platform, arch } from "node:os";
import { join, resolve } from "node:path";
import { ZimloStore } from "../apps/cli/dist/store.js";
const root = resolve(import.meta.dirname, "..");
const fixture = mkdtempSync(join(tmpdir(), "zimlo-product-scale-"));
const database = join(fixture, "scale.db");
const store = new ZimloStore(database);
const db = store.database;
const stamp = "2026-09-01T00:00:00.000Z";
const capabilities = JSON.stringify({ discovered: true, liveObserved: false, replyable: false, approvableOnce: false, approvableSession: false, approvablePersistent: false, resumable: true, diffAvailable: false });
let runtime;
function stats(values) { const sorted = values.toSorted((a,b) => a-b); const at = (p) => +sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)].toFixed(3); return { samples: sorted.length, p50:at(.5), p95:at(.95), p99:at(.99) }; }
function measure(fn) { const samples=[]; for(let i=0;i<35;i++){const start=performance.now();fn();if(i>=5)samples.push(performance.now()-start);}return stats(samples); }
try {
  db.exec("BEGIN");
  db.prepare("INSERT INTO metadata(key,value) VALUES('host_identity_v1','scale-host')").run();
  db.prepare("INSERT INTO devices(id,name,key_base64,created_at,last_seen_at,is_local_admin,can_approve,can_manage_trust) VALUES('scale-device','Fixture','fixture-key',?,?,1,1,1)").run(stamp,stamp);
  db.prepare("INSERT INTO projects(id,name,created_at,last_used_at) VALUES('scale-project','Scale fixture',?,?)").run(stamp,stamp);
  const session = db.prepare("INSERT INTO sessions(id,project_id,provider,provider_session_id,title,status,last_activity_at,created_at,capabilities_json) VALUES(?,'scale-project','codex',?,?,'completed',?,?,?)");
  const event = db.prepare("INSERT INTO events(id,provider,session_id,provider_session_id,kind,source,occurred_at,payload_json,provenance) VALUES(?,'codex',?,?,?,'app_server',?,?,'verified')");
  const post = db.prepare("INSERT INTO feed_posts(id,project_id,task_id,run_id,agent_id,session_id,kind,title,body,dedupe_key,source,created_at,content_json) VALUES(?,'scale-project',?,'run','agent',?,'result',?,?,?,'agent',?,'{}')");
  for(let s=0;s<1000;s++) {
    const id=`session-${s}`; session.run(id,id,`Codex · ${s.toString(16).padStart(8,'0')}`,stamp,stamp,capabilities);
    for(let e=0;e<100;e++)event.run(`${id}-event-${e}`,id,id,e%5===0?'user_instruction':'assistant_message',stamp,JSON.stringify({prompt:`Fixture ${s} step ${e}: `+'inspect '.repeat(25)}));
    for(let p=0;p<10;p++)post.run(`${id}-post-${p}`,id,id,`Result ${s} ${p}`,"Verified fixture conclusion. ".repeat(40),`${id}-${p}`,stamp);
  }
  db.exec("COMMIT; CREATE INDEX events_first_input_idx ON events(session_id,sequence) WHERE kind='user_instruction'; CREATE INDEX feed_posts_history_idx ON feed_posts(created_at DESC,id DESC); CREATE TABLE history_material_links(material_id TEXT,post_id TEXT,project_id TEXT,session_id TEXT,PRIMARY KEY(material_id,post_id));");
  const optimizedSQL = readFileSync(join(root,"runtime/crates/zimlo-store/src/task_inputs.rs"),"utf8").match(/\.prepare\(\s*"([\s\S]*?)"\s*,?\s*\)/)[1];
  const old = db.prepare("SELECT session_id,payload_json FROM events WHERE kind='user_instruction' ORDER BY sequence ASC");
  const optimized = db.prepare(optimizedSQL);
  const previous = () => { const result=new Map();for(const row of old.all())if(!result.has(row.session_id))result.set(row.session_id,JSON.parse(row.payload_json).prompt);return result; };
  const next = () => new Map(optimized.all().map((row)=>[row.id,JSON.parse(Object.values(row)[1]).prompt]));
  assert.deepEqual(next(),previous());
  const before=measure(previous), after=measure(next);
  const plan=db.prepare('EXPLAIN QUERY PLAN '+optimizedSQL).all().map((row)=>row.detail);
  assert(plan.some((line)=>line.includes('events_first_input_idx')));
  const port = await new Promise((resolvePort) => { const server=createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolvePort(port));}); });
  runtime=spawn(join(root,"runtime/target/release/zimlo"),['start','--database',database,'--read-only','--port',String(port)],{cwd:root,env:{...process.env,ZIMLO_HOME:fixture,ZIMLO_CLOUD_DISABLED:'1'},stdio:'ignore'});
  const url=`http://127.0.0.1:${port}/api/local/snapshot`;
  let first;
  for(let i=0;i<200;i++){try{first=await fetch(url);if(first.ok)break;}catch{}await new Promise((resolveWait)=>setTimeout(resolveWait,25));}
  assert(first?.ok,'isolated Runtime started');
  const payload=await first.text();const snapshot=JSON.parse(payload);assert.equal(snapshot.sessions.length,1000);assert.equal(snapshot.posts.length,200);
  let etag=first.headers.get('etag');assert(etag);
  const full=[],conditional=[];let notModified=0;
  for(let i=0;i<30;i++) {
    let start=performance.now();const response=await fetch(url);await response.arrayBuffer();assert.equal(response.status,200);full.push(performance.now()-start);etag=response.headers.get('etag');
    start=performance.now();const cached=await fetch(url,{headers:{'if-none-match':etag}});const bytes=await cached.arrayBuffer();conditional.push(performance.now()-start);if(cached.status===304)notModified++;assert.equal(bytes.byteLength,0);
  }
  assert.equal(notModified,30);
  db.prepare("UPDATE sessions SET title='Updated fixture' WHERE id='session-0'").run();
  const changed=await fetch(url,{headers:{'if-none-match':etag}});assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),etag);
  if (process.argv.includes("--check")) {
    assert(after.p95 < before.p95 * 0.65, "first-input query regressed beyond the relative budget");
    assert(stats(conditional).p95 < stats(full).p95 * 0.25, "conditional snapshot regressed beyond the relative budget");
  }
  const report={recordedAt:new Date().toISOString(),environment:{platform:platform(),architecture:arch(),runtime:'release; read-only; Cloud disabled; one loopback host'},fixture:{sessions:1000,posts:10000,events:100000,userInstructions:20000},firstInputQueryMs:{before,after},queryPlan:plan,httpSnapshotMs:stats(full),httpUnchangedMs:stats(conditional),snapshotBytes:Buffer.byteLength(payload),unchangedResponseBodyBytes:0,notModifiedResponses:notModified,limitations:['Synthetic warm database; not an iPhone or Cloud network benchmark.','Does not measure eight-hour energy, real user task completion, or multi-host transport.']};
  const output=resolve(root,process.argv[2]??'docs/benchmarks/product-scale-2026-09-06.json');mkdirSync(resolve(output,'..'),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally { if(runtime && runtime.exitCode===null){runtime.kill('SIGTERM');await new Promise((done)=>runtime.once('exit',done));} store.close();rmSync(fixture,{recursive:true,force:true}); }
