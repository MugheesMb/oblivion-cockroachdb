"""
Oblivion — deletion cascade orchestrator
Processes a pending deletion_requests row: checks retention holds, then
executes a checkpointed 4-leg purge. Each leg commits and checkpoints
independently in deletion_checkpoints, so re-running after a crash resumes
from the first incomplete leg instead of re-doing or skipping work.

This is the LOCAL version — proves the logic against real CockroachDB data.
Once verified, we wrap main()'s body as a Lambda handler unchanged.

Env vars required:
    COCKROACH_DATABASE_URL

Run:
    python cascade.py <user_id>
    python cascade.py usr_4471
"""

import os
import sys
import hashlib
import psycopg
from datetime import datetime, timezone

DB_URL = os.environ.get("COCKROACH_DATABASE_URL")
if not DB_URL:
    print("ERROR: set COCKROACH_DATABASE_URL first.")
    sys.exit(1)

# Fake S3 client for local proving — swap for boto3 once wrapped as Lambda
S3_BUCKET = "oblivion-artifacts-demo"

def s3_delete(key: str) -> bool:
    if not key:
        return True
    # In the Lambda version:
    #   import boto3
    #   boto3.client('s3').delete_object(Bucket=S3_BUCKET, Key=key)
    print(f"    [s3] would delete s3://{S3_BUCKET}/{key}")
    return True


def next_hash(event: str, user_id: str, request_id: str, prev_hash: str) -> str:
    payload = f"{event}|{user_id}|{request_id}|{prev_hash}|{datetime.now(timezone.utc).isoformat()}"
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def get_latest_hash(cur) -> str:
    cur.execute("SELECT row_hash FROM audit_ledger ORDER BY id DESC LIMIT 1")
    row = cur.fetchone()
    return row[0] if row else "00000000"


def write_audit(cur, event: str, user_id: str, request_id: str):
    prev = get_latest_hash(cur)
    h = next_hash(event, user_id, request_id, prev)
    cur.execute(
        "INSERT INTO audit_ledger (event, user_id, request_id, prev_hash, row_hash) "
        "VALUES (%s, %s, %s, %s, %s)",
        (event, user_id, str(request_id), prev, h),
    )
    return h


def checkpoint(cur, request_id, leg: str, status: str):
    cur.execute(
        """
        INSERT INTO deletion_checkpoints (request_id, leg, status, completed_at)
        VALUES (%s, %s, %s, now())
        ON CONFLICT (request_id, leg) DO UPDATE SET status = %s, completed_at = now()
        """,
        (request_id, leg, status, status),
    )


def leg_done(cur, request_id, leg: str) -> bool:
    cur.execute(
        "SELECT status FROM deletion_checkpoints WHERE request_id = %s AND leg = %s",
        (request_id, leg),
    )
    row = cur.fetchone()
    return row is not None and row[0] == "complete"


def process_request(user_id: str):
    with psycopg.connect(DB_URL, autocommit=True) as conn:
        with conn.cursor() as cur:

            # Find the pending request for this user
            cur.execute(
                "SELECT id, tenant_id FROM deletion_requests "
                "WHERE user_id = %s AND status IN ('pending', 'in_progress') "
                "ORDER BY requested_at LIMIT 1",
                (user_id,),
            )
            row = cur.fetchone()
            if not row:
                print(f"No pending deletion request for {user_id}.")
                return
            request_id, tenant_id = row
            print(f"Processing request {request_id} for {user_id}...")

            # --- Retention check ---
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
            held_rows = [r for r in rows if r[2] > 0]  # retain_days > 0 = held
            eligible_rows = [r for r in rows if r[2] == 0]

            if held_rows and not eligible_rows:
                # Everything is held — full refusal
                reason = f"{len(held_rows)} row(s) under retention: {held_rows[0][3]}"
                cur.execute(
                    "UPDATE deletion_requests SET status = 'refused', refusal_reason = %s WHERE id = %s",
                    (reason, request_id),
                )
                write_audit(cur, f"deletion.refused · {reason}", user_id, request_id)
                print(f"REFUSED — {reason}")
                return

            if held_rows:
                print(f"  {len(held_rows)} row(s) held (skipping): {held_rows[0][3]}")
                write_audit(cur, f"deletion.partial · {len(held_rows)} row(s) retained: {held_rows[0][3]}",
                            user_id, request_id)

            cur.execute("UPDATE deletion_requests SET status = 'in_progress' WHERE id = %s", (request_id,))

            eligible_ids = [r[0] for r in eligible_rows]

            # --- Leg 1: relational purge ---
            if not leg_done(cur, request_id, "relational_purge"):
                cur.execute(
                    "UPDATE agent_memory_events SET status = 'purged', purged_at = now() "
                    "WHERE id = ANY(%s)",
                    (eligible_ids,),
                )
                checkpoint(cur, request_id, "relational_purge", "complete")
                print(f"  [1/4] relational_purge: {len(eligible_ids)} rows")
            else:
                print("  [1/4] relational_purge: already complete, skipping")

            # --- Leg 2: vector purge (embeddings nulled so ANN can never recall them) ---
            if not leg_done(cur, request_id, "vector_purge"):
                cur.execute(
                    "UPDATE agent_memory_events SET embedding = NULL WHERE id = ANY(%s)",
                    (eligible_ids,),
                )
                checkpoint(cur, request_id, "vector_purge", "complete")
                print(f"  [2/4] vector_purge: embeddings cleared for {len(eligible_ids)} rows")
            else:
                print("  [2/4] vector_purge: already complete, skipping")

            # --- Leg 3: S3 purge ---
            if not leg_done(cur, request_id, "s3_purge"):
                cur.execute("SELECT s3_key FROM agent_memory_events WHERE id = ANY(%s) AND s3_key IS NOT NULL", (eligible_ids,))
                keys = [r[0] for r in cur.fetchall()]
                for k in keys:
                    s3_delete(k)
                checkpoint(cur, request_id, "s3_purge", "complete")
                print(f"  [3/4] s3_purge: {len(keys)} artifact(s)")
            else:
                print("  [3/4] s3_purge: already complete, skipping")

            # --- Leg 4: audit write + close out request ---
            if not leg_done(cur, request_id, "audit_write"):
                write_audit(cur, f"user.{user_id} · purge.complete · {len(eligible_ids)} rows, {len(held_rows)} retained",
                            user_id, request_id)
                checkpoint(cur, request_id, "audit_write", "complete")
                new_status = "complete" if not held_rows else "complete"  # complete = as much as legally possible
                cur.execute("UPDATE deletion_requests SET status = %s WHERE id = %s", (new_status, request_id))
                print("  [4/4] audit_write: chained")
            else:
                print("  [4/4] audit_write: already complete, skipping")

            print(f"\nDone. {len(eligible_ids)} purged, {len(held_rows)} retained under legal hold.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python cascade.py <user_id>")
        sys.exit(1)
    process_request(sys.argv[1])
