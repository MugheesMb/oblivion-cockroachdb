# Oblivion

**A provable "right to be forgotten" memory system for AI agents — built on CockroachDB and AWS.**

Every agentic-memory hackathon project answers "how does an agent remember?" Oblivion answers the question nobody else asked: **how does an agent's memory *provably forget*, on schedule, under legal compliance, without breaking the rest of the system?**

Agents deployed in production (support bots, booking assistants, healthcare intake flows) accumulate memory — conversations, embeddings, billing records, shared documents. Under GDPR/CCPA, users have a legal right to have that memory deleted. But some of that same data may be under a legitimate statutory retention requirement (financial records, active legal holds) that *overrides* the deletion request. Oblivion is a compliance-driven memory layer that:

- Executes a **checkpointed, resumable deletion cascade** across relational data, vector embeddings, and object storage
- **Refuses deletion** (with a logged, auditable reason) when data is under legal/financial retention — partial compliance, not silent failure
- Writes every action to a **hash-chained, tamper-evident audit ledger**
- Proves deletion via a **live before/after nearest-neighbor search** — not just "trust us," but a re-run query showing the vector is genuinely gone
- Auto-expires eligible memory via **CockroachDB row-level TTL**

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────────┐
│  React Dashboard │────▶│  FastAPI     │────▶│  CockroachDB Cloud   │
│  (control tower) │     │  (api.py)    │     │  - relational data   │
└─────────────────┘     └──────┬───────┘     │  - VECTOR + C-SPANN  │
                                │             │  - row-level TTL     │
                                ▼             └─────────────────────┘
                         ┌──────────────┐
                         │  AWS Lambda  │────▶ AWS S3
                         │ (S3 purge leg)│      (real object deletion)
                         └──────────────┘

┌──────────────────┐     ┌─────────────────────────────┐
│  Claude Code /    │────▶│  CockroachDB Managed MCP     │
│  any MCP client   │     │  Server (read-only queries)  │
└──────────────────┘     └─────────────────────────────┘
```

## Required tools — how each is meaningfully used

### CockroachDB (2 of 4 required)

**Distributed Vector Indexing** — `agent_memory_events.embedding` is a `VECTOR(768)` column with a C-SPANN index (`schema.sql`). Real embeddings are computed locally via Ollama (`nomic-embed-text`) at seed time — not random vectors. The dashboard's "Nearest-Neighbor Proof" panel runs a live ANN query before and after a purge, showing the deleted user's embedding genuinely drop out of the result set and the distance ranking shift — not a boolean "deleted: true" flag.

**CockroachDB Cloud Managed MCP Server** — connected via Claude Code (`claude mcp add cockroachdb-cloud ...`), read-only scope, OAuth-authenticated. Used to independently verify live cluster state (table row counts, retention state) outside the application layer — exactly the "AI agent queries live database state" use case the tool is built for.

### AWS (Lambda + S3)

**AWS Lambda** (`oblivion-s3-purge`, `eu-north-1`) — a real deployed function that executes the S3 leg of the deletion cascade. Invoked from `api.py` via `boto3` on every `/purge/{user_id}` call.

**Amazon S3** — real bucket (`oblivion-artifacts-demo-*`) holding per-user artifacts (e.g. `artifacts/usr_2290/boarding_pass.pdf`). The Lambda genuinely calls `s3.delete_object()` — verified by re-checking the bucket post-purge and confirming the object is gone, not by trusting a log line.

*(AWS Bedrock was intentionally not used, per the hackathon organizers' guidance that Bedrock has no free tier for this event — "blast radius" style reasoning uses a local Ollama model instead, keeping the AWS requirement satisfied entirely through Lambda + S3.)*

## The checkpointed cascade

Each deletion request walks 4 legs, each committed and checkpointed independently in `deletion_checkpoints`:

1. `relational_purge` — mark rows purged in CockroachDB
2. `vector_purge` — null out embeddings (unrecoverable by ANN)
3. `s3_purge` — invoke Lambda, delete real S3 objects
4. `audit_write` — append a hash-chained entry to `audit_ledger`

If any leg fails or the process crashes mid-cascade, re-running the same request resumes from the first incomplete leg — verified by running the cascade twice in a row and observing the second run correctly skip already-complete legs.

## Retention conflicts

Not all data can legally be deleted on request. `retention_policies` defines statutory holds (e.g. financial records, 7-year retention). When a deletion request touches held rows, Oblivion:
- Purges everything *eligible*
- **Retains** held rows, unchanged
- Logs the refusal/partial-completion with the specific legal basis, to the audit ledger

This was verified live: a user with a mix of standard and `financial`/`legal_hold` data classes had 4 rows purged and 2 correctly retained in a single request.

## Running it locally

```bash
# 1. Schema
cockroach sql --url "$COCKROACH_DATABASE_URL" -f schema.sql

# 2. Seed (requires Ollama running with nomic-embed-text pulled)
pip install "psycopg[binary]" requests
python seed.py

# 3. Backend API
pip install fastapi uvicorn boto3
export COCKROACH_DATABASE_URL="postgresql://..."
export AWS_REGION="eu-north-1"
export OBLIVION_LAMBDA_NAME="oblivion-s3-purge"
export OBLIVION_S3_BUCKET="your-bucket-name"
uvicorn api:app --reload --port 8000

# 4. Dashboard
npm create vite@latest oblivion-dashboard -- --template react
cd oblivion-dashboard && npm install && npm install lucide-react tailwindcss @tailwindcss/vite
# copy oblivion_dashboard.jsx -> src/App.jsx, index.css -> src/index.css
npm run dev
```

`cascade.py` is also included as a standalone CLI version of the same deletion logic, useful for direct testing against the database independent of the API layer.

## Stack

CockroachDB Cloud · FastAPI · React (Vite + Tailwind) · AWS Lambda · Amazon S3 · Ollama (local embeddings, `nomic-embed-text`) · Claude Code (MCP client)

## License

MIT
