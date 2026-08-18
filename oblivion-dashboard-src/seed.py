"""
Oblivion — seed script
Populates CockroachDB with synthetic tenants/users/memory events, computing
REAL embeddings via a local Ollama instance (not random vectors — semantic
search only means something if the vectors actually encode meaning).

Setup:
    pip install "psycopg[binary]" requests

Env vars required:
    COCKROACH_DATABASE_URL   e.g. postgresql://user:pass@host:26257/defaultdb?sslmode=verify-full
    OLLAMA_HOST              default: http://localhost:11434

Run:
    python seed.py
"""

import os
import sys
import uuid
import requests
import psycopg
from datetime import datetime, timedelta, timezone

DB_URL = os.environ.get("COCKROACH_DATABASE_URL")
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
EMBED_MODEL = "nomic-embed-text"

if not DB_URL:
    print("ERROR: set COCKROACH_DATABASE_URL first.")
    sys.exit(1)


def embed(text: str) -> list[float]:
    """Call local Ollama for a real 768-dim embedding."""
    r = requests.post(
        f"{OLLAMA_HOST}/api/embeddings",
        json={"model": EMBED_MODEL, "prompt": text},
        timeout=30,
    )
    r.raise_for_status()
    vec = r.json()["embedding"]
    if len(vec) != 768:
        print(f"WARNING: embedding dim is {len(vec)}, schema expects 768.")
    return vec


def vec_literal(vec: list[float]) -> str:
    """CockroachDB VECTOR literal format: '[0.1,0.2,...]'"""
    return "[" + ",".join(f"{v:.8f}" for v in vec) + "]"


# ---------------------------------------------------------------------
# Fixture data — mirrors the dashboard mock exactly (same IDs, same names)
# ---------------------------------------------------------------------

TENANTS = ["Vueling Ops", "Northwind Retail", "Halden Health"]

USERS = [
    {"id": "usr_4471", "name": "M. Ferreira", "tenant": "Vueling Ops", "status": "active"},
    {"id": "usr_2290", "name": "K. Solberg", "tenant": "Northwind Retail", "status": "active"},
    {"id": "usr_8813", "name": "R. Okonjo", "tenant": "Halden Health", "status": "active"},  # held via memory rows, not user status
]

# Each entry: (user_id, event_type, content_summary, data_class, related_user_id, s3_key)
MEMORY_EVENTS = [
    # usr_4471 — 5 touchpoints, all active
    ("usr_4471", "convo", "Customer asked about refund status for booking BCN-LHR change fee", "standard", None, None),
    ("usr_4471", "embed", "Support transcript embedding: refund policy explanation for EU flights", "standard", None, None),
    ("usr_4471", "s3", "Uploaded receipt image for change-fee dispute, case #BCN-4471", "standard", None, "artifacts/usr_4471/receipt_4471.pdf"),
    ("usr_4471", "billing", "Refund #4471 processed for booking change, amount pending settlement", "standard", None, None),
    ("usr_4471", "contract", "Co-signed shared itinerary contract for group booking with usr_2290", "standard", "usr_2290", None),

    # usr_2290 — 4 touchpoints, all active
    ("usr_2290", "convo", "Customer requested itinerary change for connecting flight to Oslo", "standard", None, None),
    ("usr_2290", "embed", "Support transcript embedding: connecting flight rebooking policy", "standard", None, None),
    ("usr_2290", "s3", "Uploaded boarding pass for rebooking verification", "standard", None, "artifacts/usr_2290/boarding_pass.pdf"),
    ("usr_2290", "billing", "Refund note attached to shared group booking, ref #4471", "standard", None, None),

    # usr_8813 — 6 touchpoints, includes legal-hold rows
    ("usr_8813", "convo", "Patient intake conversation regarding appointment scheduling", "sensitive", None, None),
    ("usr_8813", "embed", "Intake form embedding: scheduling preferences and contact consent", "sensitive", None, None),
    ("usr_8813", "s3", "Uploaded intake form PDF for appointment #8813", "sensitive", None, "artifacts/usr_8813/intake_8813.pdf"),
    ("usr_8813", "billing", "Refund #4471-adjacent billing note for shared household account", "standard", None, None),
    ("usr_8813", "contract", "Co-signed household billing agreement with usr_2290", "legal_hold", "usr_2290", None),
    ("usr_8813", "billing", "Insurance billing record — statutory 7yr financial retention applies", "financial", None, None),
]


def main():
    print(f"Connecting to CockroachDB...")
    with psycopg.connect(DB_URL, autocommit=True) as conn:
        with conn.cursor() as cur:

            # --- Tenants ---
            tenant_ids = {}
            for name in TENANTS:
                cur.execute(
                    "INSERT INTO tenants (name) VALUES (%s) "
                    "ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name "
                    "RETURNING id",
                    (name,),
                )
                tenant_ids[name] = cur.fetchone()[0]
            print(f"Tenants: {tenant_ids}")

            # --- Users ---
            for u in USERS:
                cur.execute(
                    "INSERT INTO users (id, tenant_id, display_name, status) "
                    "VALUES (%s, %s, %s, %s) "
                    "ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name",
                    (u["id"], tenant_ids[u["tenant"]], u["name"], u["status"]),
                )
            print(f"Users: {[u['id'] for u in USERS]}")

            # --- Memory events (with real embeddings) ---
            user_tenant = {u["id"]: tenant_ids[u["tenant"]] for u in USERS}
            for i, (uid, etype, summary, dclass, related, s3key) in enumerate(MEMORY_EVENTS):
                print(f"  embedding {i+1}/{len(MEMORY_EVENTS)}: {uid} · {etype}...")
                vec = embed(summary)
                status = "held" if dclass in ("legal_hold", "financial") else "active"
                cur.execute(
                    """
                    INSERT INTO agent_memory_events
                        (user_id, tenant_id, event_type, content_summary, embedding,
                         data_class, related_user_id, s3_key, status)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (uid, user_tenant[uid], etype, summary, vec_literal(vec),
                     dclass, related, s3key, status),
                )
            print(f"Inserted {len(MEMORY_EVENTS)} memory events with real embeddings.")

            # --- Pending deletion requests (SLA queue demo data) ---
            now = datetime.now(timezone.utc)
            requests_seed = [
                ("usr_4471", now + timedelta(minutes=2)),   # near-breach, for the demo
                ("usr_2290", now + timedelta(hours=6)),
                ("usr_8813", now + timedelta(hours=12)),    # will hit the retention refusal when processed
            ]
            for uid, deadline in requests_seed:
                cur.execute(
                    """
                    INSERT INTO deletion_requests (user_id, tenant_id, sla_deadline, status)
                    VALUES (%s, %s, %s, 'pending')
                    """,
                    (uid, user_tenant[uid], deadline),
                )
            print("Seeded 3 pending deletion requests.")

    print("\nDone. Verify with:")
    print("  SELECT id, event_type, data_class, status FROM agent_memory_events ORDER BY user_id;")
    print("  SELECT user_id, sla_deadline, status FROM deletion_requests;")


if __name__ == "__main__":
    main()
