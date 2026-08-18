-- =====================================================================
-- OBLIVION — CockroachDB schema
-- Compliance-driven ("right to be forgotten") agent memory system
-- Run against your CockroachDB Cloud cluster:
--   cockroach sql --url "$COCKROACH_DATABASE_URL" -f schema.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tenants & users
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        STRING NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id          STRING PRIMARY KEY,               -- e.g. 'usr_4471'
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    display_name STRING NOT NULL,
    status      STRING NOT NULL DEFAULT 'active'   -- active | purged
                CHECK (status IN ('active', 'purged')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Agent memory events — the durable memory an agent accumulates,
-- plus its vector embedding for semantic recall / ANN proof.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_memory_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         STRING NOT NULL REFERENCES users(id),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    event_type      STRING NOT NULL              -- convo | embed | s3 | billing | contract
                    CHECK (event_type IN ('convo', 'embed', 's3', 'billing', 'contract')),
    content_summary STRING,                       -- human-readable note, never raw PII
    embedding       VECTOR(768),                  -- adjust dim to your embedding model
    data_class      STRING NOT NULL DEFAULT 'standard'
                    CHECK (data_class IN ('standard', 'financial', 'legal_hold', 'sensitive')),
    related_user_id STRING REFERENCES users(id),  -- for co-signed / shared records
    s3_key          STRING,                       -- pointer to S3 artifact, if any
    status          STRING NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'purged', 'held')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    purged_at       TIMESTAMPTZ
);

-- Distributed vector index (C-SPANN) for ANN search / semantic recall proof
CREATE VECTOR INDEX IF NOT EXISTS idx_memory_embedding
    ON agent_memory_events (embedding);

CREATE INDEX IF NOT EXISTS idx_memory_user ON agent_memory_events (user_id);
CREATE INDEX IF NOT EXISTS idx_memory_tenant_status ON agent_memory_events (tenant_id, status);

-- ---------------------------------------------------------------------
-- Retention policies — legal holds that override a deletion request
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS retention_policies (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    data_class      STRING NOT NULL UNIQUE,
    retain_days     INT NOT NULL,
    legal_basis     STRING NOT NULL,               -- e.g. 'financial records - 7yr statutory'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO retention_policies (data_class, retain_days, legal_basis)
VALUES
    ('financial', 2555, 'financial records - 7yr statutory retention'),
    ('legal_hold', 3650, 'active legal hold - 10yr default'),
    ('standard', 0, 'no statutory retention - deletable on request'),
    ('sensitive', 0, 'no statutory retention - deletable on request')
ON CONFLICT (data_class) DO NOTHING;

-- Row-level TTL for standard/sensitive memory: auto-expire after 180 days
-- of inactivity unless a deletion request or legal hold intervenes.
ALTER TABLE agent_memory_events
    SET (ttl_expire_after = '180 days', ttl_expiration_expression =
         $$CASE WHEN data_class IN ('standard', 'sensitive') THEN created_at + interval '180 days' ELSE NULL END$$);

-- ---------------------------------------------------------------------
-- Deletion requests — the "right to be forgotten" work queue
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deletion_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         STRING NOT NULL REFERENCES users(id),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    sla_deadline    TIMESTAMPTZ NOT NULL,
    status          STRING NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'in_progress', 'complete', 'refused')),
    refusal_reason  STRING
);

CREATE INDEX IF NOT EXISTS idx_deletion_status_deadline
    ON deletion_requests (status, sla_deadline);

-- ---------------------------------------------------------------------
-- Deletion checkpoints — each leg of the purge cascade commits and
-- checkpoints independently, so a crash mid-cascade resumes cleanly
-- instead of double-purging or silently skipping a leg.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deletion_checkpoints (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id      UUID NOT NULL REFERENCES deletion_requests(id),
    leg             STRING NOT NULL
                    CHECK (leg IN ('relational_purge', 'vector_purge', 's3_purge', 'audit_write')),
    status          STRING NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'complete', 'failed')),
    completed_at    TIMESTAMPTZ,
    UNIQUE (request_id, leg)
);

-- ---------------------------------------------------------------------
-- Audit ledger — hash-chained, tamper-evident. Each row's hash covers
-- (event + timestamp + previous row's hash), so any modification after
-- the fact breaks the chain from that point forward and is detectable
-- by recomputing hashes and comparing to what's stored.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_ledger (
    id              INT8 PRIMARY KEY DEFAULT unique_rowid(),
    event           STRING NOT NULL,
    user_id         STRING REFERENCES users(id),
    request_id      UUID REFERENCES deletion_requests(id),
    prev_hash       STRING NOT NULL,
    row_hash        STRING NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_ledger (user_id);

-- Seed the genesis block
INSERT INTO audit_ledger (event, prev_hash, row_hash)
SELECT 'cluster.init', '00000000', encode(sha256('genesis'::bytes), 'hex')
WHERE NOT EXISTS (SELECT 1 FROM audit_ledger WHERE event = 'cluster.init');

-- =====================================================================
-- Notes for the application layer:
--
-- 1. Computing row_hash: sha256(event || user_id || request_id ||
--    created_at || prev_hash), done in the Lambda before insert —
--    CockroachDB just stores the result, it doesn't compute the chain.
--
-- 2. Deletion cascade (Lambda orchestrator), per request:
--    a. Check retention_policies for the user's memory rows' data_class.
--       If any row is 'financial' or 'legal_hold' and still within
--       retain_days, mark deletion_requests.status = 'refused' with a
--       reason, write an audit_ledger row, and STOP for those rows —
--       purge only the remaining eligible rows.
--    b. For eligible rows, in order, each in its own transaction,
--       updating deletion_checkpoints after each commit:
--         relational_purge -> vector_purge -> s3_purge -> audit_write
--    c. On restart after a crash, read deletion_checkpoints for the
--       request and resume from the first non-'complete' leg — never
--       re-run a completed leg, never skip a pending one.
--
-- 3. TTL handles the *unrequested* case (rows nobody explicitly asked
--    to delete, but which aged past policy) — deletion_requests handles
--    the *explicit* "forget me" case. Both funnel through the same
--    checkpointed cascade logic in the Lambda.
-- =====================================================================
