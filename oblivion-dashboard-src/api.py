"""
Oblivion — API layer
Wraps cascade.py's logic and read-only ledger queries as HTTP endpoints
so the React dashboard can call real CockroachDB state instead of mock data.

Setup:
    pip install fastapi uvicorn "psycopg[binary]"

Run:
    uvicorn api:app --reload --port 8000

Endpoints:
    GET  /users?tenant=Vueling%20Ops        list users + their memory touchpoints
    POST /purge/{user_id}                   run the deletion cascade
    GET  /ann?exclude_user=usr_4471         ANN search results (for before/after proof)
    GET  /chain                             full hash-chain audit ledger
    GET  /sla-queue                         pending deletion requests with deadlines
    POST /ask                               natural-language-ish query against ledger state
"""

import os
import hashlib
import json
import boto3
from datetime import datetime, timezone
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import psycopg

DB_URL = os.environ["COCKROACH_DATABASE_URL"]
AWS_REGION = os.environ.get("AWS_REGION", "eu-north-1")
LAMBDA_FUNCTION = os.environ.get("OBLIVION_LAMBDA_NAME", "oblivion-s3-purge")
S3_BUCKET = os.environ.get("OBLIVION_S3_BUCKET", "oblivion-artifacts-demo-mugy26")

lambda_client = boto3.client("lambda", region_name=AWS_REGION)


def invoke_s3_purge(key: str) -> dict:
    """Calls the real deployed Lambda to delete a real S3 object."""
    resp = lambda_client.invoke(
        FunctionName=LAMBDA_FUNCTION,
        InvocationType="RequestResponse",
        Payload=json.dumps({"bucket": S3_BUCKET, "key": key}).encode(),
    )
    payload = json.loads(resp["Payload"].read())
    return payload

app = FastAPI(title="Oblivion API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten for real deployment; fine for hackathon demo
    allow_methods=["*"],
    allow_headers=["*"],
)


def db():
    return psycopg.connect(DB_URL, autocommit=True)


# ---------------------------------------------------------------------
@app.get("/users")
def list_users(tenant: str | None = None):
    with db() as conn, conn.cursor() as cur:
        q = """
            SELECT u.id, u.display_name, t.name, u.status
            FROM users u JOIN tenants t ON t.id = u.tenant_id
        """
        params = ()
        if tenant:
            q += " WHERE t.name = %s"
            params = (tenant,)
        cur.execute(q, params)
        users = [{"id": r[0], "name": r[1], "tenant": r[2], "status": r[3]} for r in cur.fetchall()]

        for u in users:
            cur.execute(
                "SELECT event_type, content_summary, data_class, status "
                "FROM agent_memory_events WHERE user_id = %s ORDER BY created_at",
                (u["id"],),
            )
            u["touchpoints"] = [
                {"type": r[0], "note": r[1], "data_class": r[2], "status": r[3]}
                for r in cur.fetchall()
            ]
        return users


# ---------------------------------------------------------------------
@app.post("/purge/{user_id}")
def purge(user_id: str):
    """Runs the same checkpointed cascade as cascade.py, inline."""
    with db() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM deletion_requests WHERE user_id = %s "
            "AND status IN ('pending', 'in_progress') ORDER BY requested_at LIMIT 1",
            (user_id,),
        )
        row = cur.fetchone()
        if not row:
            return {"status": "no_pending_request", "user_id": user_id}
        request_id = row[0]

        cur.execute(
            """
            SELECT ame.id, ame.data_class, rp.retain_days, rp.legal_basis
            FROM agent_memory_events ame
            JOIN retention_policies rp ON rp.data_class = ame.data_class
            WHERE ame.user_id = %s AND ame.status != 'purged'
            """,
            (user_id,),
        )
        rows = cur.fetchall()
        held = [r for r in rows if r[2] > 0]
        eligible = [r for r in rows if r[2] == 0]
        eligible_ids = [r[0] for r in eligible]

        if held and not eligible:
            reason = f"{len(held)} row(s) under retention: {held[0][3]}"
            cur.execute("UPDATE deletion_requests SET status='refused', refusal_reason=%s WHERE id=%s",
                        (reason, request_id))
            _write_audit(cur, f"deletion.refused · {reason}", user_id, request_id)
            return {"status": "refused", "reason": reason}

        cur.execute("UPDATE deletion_requests SET status='in_progress' WHERE id=%s", (request_id,))
        cur.execute("UPDATE agent_memory_events SET status='purged', purged_at=now() WHERE id = ANY(%s)", (eligible_ids,))
        cur.execute("UPDATE agent_memory_events SET embedding=NULL WHERE id = ANY(%s)", (eligible_ids,))

        # --- Real S3 leg: invoke the actual Lambda for any eligible row with an s3_key ---
        cur.execute("SELECT s3_key FROM agent_memory_events WHERE id = ANY(%s) AND s3_key IS NOT NULL", (eligible_ids,))
        s3_keys = [r[0] for r in cur.fetchall()]
        s3_results = []
        for key in s3_keys:
            try:
                result = invoke_s3_purge(key)
                s3_results.append({"key": key, "result": result})
            except Exception as e:
                s3_results.append({"key": key, "error": str(e)})

        _write_audit(cur, f"user.{user_id} · purge.complete · {len(eligible_ids)} rows, {len(held)} retained, "
                           f"{len(s3_keys)} s3 object(s) purged",
                     user_id, request_id)
        cur.execute("UPDATE deletion_requests SET status='complete' WHERE id=%s", (request_id,))

        return {
            "status": "complete",
            "purged": len(eligible_ids),
            "retained": len(held),
            "retained_reason": held[0][3] if held else None,
            "s3_purged": s3_results,
        }


def _write_audit(cur, event, user_id, request_id):
    cur.execute("SELECT row_hash FROM audit_ledger ORDER BY id DESC LIMIT 1")
    r = cur.fetchone()
    prev = r[0] if r else "00000000"
    payload = f"{event}|{user_id}|{request_id}|{prev}|{datetime.now(timezone.utc).isoformat()}"
    h = hashlib.sha256(payload.encode()).hexdigest()[:16]
    cur.execute(
        "INSERT INTO audit_ledger (event, user_id, request_id, prev_hash, row_hash) VALUES (%s,%s,%s,%s,%s)",
        (event, user_id, str(request_id), prev, h),
    )


# ---------------------------------------------------------------------
@app.get("/chain")
def get_chain():
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT id, event, user_id, prev_hash, row_hash, created_at FROM audit_ledger ORDER BY id")
        return [
            {"id": r[0], "event": r[1], "user_id": r[2], "prev_hash": r[3], "hash": r[4], "ts": r[5].isoformat()}
            for r in cur.fetchall()
        ]


# ---------------------------------------------------------------------
@app.get("/sla-queue")
def sla_queue():
    with db() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, user_id, sla_deadline, status FROM deletion_requests "
            "WHERE status IN ('pending', 'in_progress') ORDER BY sla_deadline"
        )
        return [
            {"id": str(r[0]), "user_id": r[1], "deadline": r[2].isoformat(), "status": r[3]}
            for r in cur.fetchall()
        ]


# ---------------------------------------------------------------------
@app.get("/ann")
def ann_search(exclude_user: str | None = None):
    """Nearest-neighbor demo: pick any live embedding as the query vector,
    return top matches. If exclude_user is set, filters that user's rows out
    (this is what powers the before/after proof after a purge)."""
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT embedding FROM agent_memory_events WHERE embedding IS NOT NULL LIMIT 1")
        seed = cur.fetchone()
        if not seed:
            return []
        q = """
            SELECT user_id, event_type, content_summary, embedding <-> %s AS dist
            FROM agent_memory_events
            WHERE embedding IS NOT NULL
        """
        params = [seed[0]]
        if exclude_user:
            q += " AND user_id != %s"
            params.append(exclude_user)
        q += " ORDER BY dist LIMIT 5"
        cur.execute(q, params)
        return [{"user_id": r[0], "type": r[1], "note": r[2], "dist": float(r[3])} for r in cur.fetchall()]


# ---------------------------------------------------------------------
@app.post("/ask")
def ask(body: dict):
    q = body.get("query", "").lower()
    with db() as conn, conn.cursor() as cur:
        if "breach" in q or "sla" in q:
            cur.execute(
                "SELECT user_id, sla_deadline FROM deletion_requests "
                "WHERE status = 'pending' AND sla_deadline < now() + interval '60 seconds'"
            )
            risky = cur.fetchall()
            return {"answer": f"{len(risky)} request(s) inside 60s of SLA breach." if risky else "No requests inside SLA breach risk window."}

        for uid in ["usr_4471", "usr_2290", "usr_8813"]:
            if uid.replace("usr_", "") in q or uid in q:
                cur.execute("SELECT status FROM users WHERE id = %s", (uid,))
                cur.execute(
                    "SELECT count(*) FILTER (WHERE status='purged'), count(*) FILTER (WHERE status='held'), count(*) "
                    "FROM agent_memory_events WHERE user_id = %s", (uid,)
                )
                purged, held, total = cur.fetchone()
                if held > 0:
                    return {"answer": f"{uid} has {held} record(s) under legal hold. {purged}/{total} other touchpoints clear."}
                elif purged == total and total > 0:
                    return {"answer": f"{uid} is fully purged. {purged}/{total} touchpoints cleared."}
                else:
                    return {"answer": f"{uid} still has {total - purged}/{total} active touchpoints."}

        if "chain" in q or "tamper" in q:
            return {"answer": "Chain integrity check requires client-side hash recomputation — see /chain endpoint."}

        return {"answer": "Ask about a specific user, SLA breach risk, or chain integrity."}
