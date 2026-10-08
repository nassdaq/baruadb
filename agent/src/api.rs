//! Agent HTTP API, called by the control plane (Cloudflare Worker).
//! Every route needs `Authorization: Bearer <agent token>`.

use std::sync::Arc;

use anyhow::Result;
use axum::extract::{Path, Query, Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tracing::{info, warn};

use crate::app::{App, DbRecord, Location, Status};
use crate::pg::{Target, valid_name};
use crate::stats::BoxStats;

type AppState = Arc<App>;

pub struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        let msg = format!("{e:#}");
        let code = if msg.contains("not found") {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        ApiError(code, msg)
    }
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}

type ApiResult<T> = Result<Json<T>, ApiError>;

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn auth(State(app): State<AppState>, req: Request, next: Next) -> Response {
    let Some(token) = app.api_token() else {
        return ApiError(StatusCode::SERVICE_UNAVAILABLE, "agent has no API token yet".into()).into_response();
    };
    let given = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if !constant_time_eq(given.as_bytes(), token.as_bytes()) {
        return ApiError(StatusCode::UNAUTHORIZED, "bad token".into()).into_response();
    }
    next.run(req).await
}

#[derive(Serialize)]
struct DbView {
    #[serde(flatten)]
    db: DbRecord,
    running: bool,
    connections: usize,
    memory_bytes: Option<u64>,
}

fn view(app: &App, db: DbRecord) -> DbView {
    let rt = app.runtime(&db.id);
    DbView {
        running: rt.is_running(),
        connections: rt.connections(),
        memory_bytes: app.cgroups.memory_current(&db.id),
        db,
    }
}

pub fn router(app: AppState) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/databases", get(list).post(create))
        .route("/v1/databases/{id}", get(show).delete(delete))
        .route("/v1/databases/{id}/wake", post(wake))
        .route("/v1/databases/{id}/suspend", post(suspend))
        .route("/v1/databases/{id}/evict", post(evict))
        .route("/v1/databases/{id}/snapshot", post(snapshot))
        .route("/v1/databases/{id}/snapshots", get(snapshots))
        .route("/v1/databases/{id}/sync", post(sync))
        .route("/v1/databases/{id}/query", post(query))
        .route("/v1/databases/{id}/dump", get(dump))
        .route("/v1/databases/{id}/release", post(release))
        .route("/v1/databases/{id}/password", post(password))
        .layer(middleware::from_fn_with_state(app.clone(), auth))
        .with_state(app)
}

async fn health(State(app): State<AppState>) -> ApiResult<BoxStats> {
    Ok(Json(BoxStats::collect(&app)))
}

async fn list(State(app): State<AppState>) -> ApiResult<Vec<DbView>> {
    let dbs: Vec<DbRecord> = app.meta(|m| m.databases.values().cloned().collect());
    Ok(Json(dbs.into_iter().map(|d| view(&app, d)).collect()))
}

async fn show(State(app): State<AppState>, Path(id): Path<String>) -> ApiResult<DbView> {
    Ok(Json(view(&app, app.db(&id)?)))
}

#[derive(Deserialize)]
struct RestoreReq {
    /// Database whose snapshots + WAL to restore from (the parent for a
    /// branch, the database itself when moving it between boxes).
    source: String,
    target: Target,
}

#[derive(Deserialize)]
struct CreateReq {
    id: String,
    role: String,
    database: String,
    password: Option<String>,
    parent: Option<String>,
    restore: Option<RestoreReq>,
    /// How often WAL is shipped for this database (seconds); the box default
    /// when absent. The control plane sets it per plan.
    archive_timeout_secs: Option<u32>,
}

async fn create(
    State(app): State<AppState>,
    Json(req): Json<CreateReq>,
) -> Result<(StatusCode, Json<DbView>), ApiError> {
    for (what, v) in [("id", &req.id), ("role", &req.role), ("database", &req.database)] {
        if !valid_name(v) {
            return Err(bad(format!(
                "{what} must be 1-63 chars of a-z, 0-9, _ or -, starting with a letter"
            )));
        }
    }
    if req.role == crate::pg::ADMIN_ROLE || req.role.starts_with("pg_") {
        return Err(bad("that role name is reserved"));
    }
    if req.restore.is_none() && req.password.as_deref().is_none_or(|p| p.len() < 12) {
        return Err(bad("password of at least 12 characters is required"));
    }
    let db = DbRecord {
        id: req.id.clone(),
        role: req.role.clone(),
        database: req.database.clone(),
        port: 0,
        parent: req.parent.clone(),
        status: Status::Creating,
        location: Location::Local,
        error: None,
        fenced: false,
        created_at: Utc::now(),
        last_used_at: Utc::now(),
        last_snapshot_at: None,
        last_snapshot_lsn: None,
        archive_timeout_secs: req.archive_timeout_secs.filter(|s| (1..=3600).contains(s)),
    };
    app.update_meta(|m| {
        if m.databases.contains_key(&db.id) {
            anyhow::bail!("database {} already exists on this box", db.id);
        }
        let used: std::collections::HashSet<u16> = m.databases.values().map(|d| d.port).collect();
        let port = (app.cfg.port_base..)
            .find(|p| !used.contains(p))
            .expect("ports exhausted");
        m.databases.insert(db.id.clone(), DbRecord { port, ..db.clone() });
        Ok(())
    })
    .map_err(|e| ApiError(StatusCode::CONFLICT, format!("{e:#}")))?;

    let bg = app.clone();
    let id = req.id.clone();
    tokio::spawn(async move {
        let source = req.restore.as_ref().map(|r| (r.source.as_str(), r.target));
        let started = std::time::Instant::now();
        if bg
            .create(&req.id, &req.role, &req.database, req.password.as_deref(), source)
            .await
            .is_ok()
        {
            info!(
                db = req.id,
                ms = started.elapsed().as_millis() as u64,
                "database created"
            );
        }
    });
    Ok((StatusCode::ACCEPTED, Json(view(&app, app.db(&id)?))))
}

#[derive(Deserialize)]
struct DeleteQuery {
    purge: Option<bool>,
}

async fn delete(
    State(app): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<DeleteQuery>,
) -> ApiResult<serde_json::Value> {
    app.db(&id)?;
    app.delete(&id, q.purge.unwrap_or(true)).await?;
    Ok(Json(json!({ "deleted": id })))
}

async fn wake(State(app): State<AppState>, Path(id): Path<String>) -> ApiResult<DbView> {
    let db = app.ensure_ready(&id).await?;
    Ok(Json(view(&app, db)))
}

#[derive(Deserialize)]
struct SuspendQuery {
    force: Option<bool>,
}

async fn suspend(
    State(app): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<SuspendQuery>,
) -> ApiResult<serde_json::Value> {
    app.db(&id)?;
    let done = app.suspend(&id, q.force.unwrap_or(false)).await?;
    Ok(Json(json!({ "suspended": done })))
}

async fn evict(State(app): State<AppState>, Path(id): Path<String>) -> ApiResult<serde_json::Value> {
    let done = app.evict(&id).await?;
    Ok(Json(json!({ "evicted": done })))
}

async fn snapshot(State(app): State<AppState>, Path(id): Path<String>) -> ApiResult<crate::storage::SnapshotInfo> {
    Ok(Json(app.snapshot(&id).await?))
}

async fn snapshots(
    State(app): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Vec<crate::storage::SnapshotInfo>> {
    Ok(Json(app.storage.list_snapshots(&id).await?))
}

/// Stream a logical backup straight from pg_dump to the caller. Nothing is
/// written to the box's disk: a database may be most of the free space, and a
/// customer asking for a copy should not be able to fill the box to get it.
async fn dump(State(app): State<AppState>, Path(id): Path<String>) -> Result<Response, ApiError> {
    use tokio::process::Command;

    let db = app.ensure_ready(&id).await.map_err(|e| ApiError(StatusCode::CONFLICT, format!("{e:#}")))?;
    let _guard = crate::app::ConnectionGuard::new(app.runtime(&id));

    let mut child = Command::new(app.cfg.pg("pg_dump"))
        .args(["-h", &app.db_dir(&id).to_string_lossy()])
        .args(["-p", &db.port.to_string()])
        .args(["-U", crate::pg::ADMIN_ROLE])
        .args(["--no-owner", "--no-privileges", "--format", "plain"])
        .arg(&db.database)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("pg_dump: {e}")))?;

    let stdout = child.stdout.take().expect("piped");
    // Hold the child until the stream ends, so it is reaped rather than orphaned.
    tokio::spawn(async move {
        let _ = child.wait().await;
    });

    let stream = tokio_util::io::ReaderStream::new(stdout);
    let body = axum::body::Body::from_stream(stream);
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "application/sql".to_string()),
            (
                axum::http::header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{id}.sql\""),
            ),
        ],
        body,
    )
        .into_response())
}

#[derive(Deserialize)]
struct QueryBody {
    sql: String,
    limit: Option<usize>,
}

/// Run SQL as the database's own role. Used by the dashboard's table browser
/// and SQL editor, so that a browser never needs the database password.
async fn query(
    State(app): State<AppState>,
    Path(id): Path<String>,
    Json(b): Json<QueryBody>,
) -> ApiResult<crate::pg::QueryResult> {
    let limit = b.limit.unwrap_or(200).clamp(1, 1000);
    Ok(Json(app.query(&id, &b.sql, limit).await?))
}

async fn sync(State(app): State<AppState>, Path(id): Path<String>) -> ApiResult<serde_json::Value> {
    let lsn = app.sync(&id).await?;
    Ok(Json(json!({ "lsn": lsn })))
}

async fn release(State(app): State<AppState>, Path(id): Path<String>) -> ApiResult<serde_json::Value> {
    app.release(&id).await?;
    Ok(Json(json!({ "released": id })))
}

#[derive(Deserialize)]
struct PasswordReq {
    password: String,
}

async fn password(
    State(app): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<PasswordReq>,
) -> ApiResult<serde_json::Value> {
    if req.password.len() < 12 {
        return Err(bad("password must be at least 12 characters"));
    }
    app.set_password(&id, &req.password).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn serve(app: AppState, tls: Option<TlsAcceptor>) -> Result<()> {
    let listener = TcpListener::bind(&app.cfg.api_addr).await?;
    info!(addr = %app.cfg.api_addr, tls = tls.is_some(), "agent API listening");
    let router = router(app);
    let Some(tls) = tls else {
        axum::serve(listener, router).await?;
        return Ok(());
    };
    loop {
        let (sock, peer) = listener.accept().await?;
        let (tls, router) = (tls.clone(), router.clone());
        tokio::spawn(async move {
            let stream = match tls.accept(sock).await {
                Ok(s) => s,
                Err(e) => return warn!(%peer, "TLS handshake failed: {e}"),
            };
            let svc = hyper_util::service::TowerToHyperService::new(router);
            let _ = hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new())
                .serve_connection(hyper_util::rt::TokioIo::new(stream), svc)
                .await;
        });
    }
}
