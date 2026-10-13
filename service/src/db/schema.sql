-- PDF service schema. In production this lives in its own schema on the existing RDS instance.

CREATE TABLE jobs (
    id               uuid PRIMARY KEY,
    kind             text NOT NULL CHECK (kind IN ('single', 'bulk')),
    status           text NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running', 'zipping', 'completed', 'failed')),
    idempotency_key  text UNIQUE,
    total            int  NOT NULL,
    done             int  NOT NULL DEFAULT 0,
    failed           int  NOT NULL DEFAULT 0,
    -- Point-in-time the caller read the ERP data (REPEATABLE READ snapshot on the Django side).
    data_as_of       timestamptz NOT NULL,
    -- Hash over the per-document payload hashes: proves which data the whole job was rendered from.
    snapshot_sha256  text NOT NULL,
    zip_key          text,
    manifest_key     text,
    part_keys        text[],
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
    id               uuid PRIMARY KEY,
    job_id           uuid NOT NULL REFERENCES jobs(id),
    seq              int  NOT NULL,
    doc_type         text NOT NULL CHECK (doc_type IN ('purchase_order', 'invoice')),
    doc_ref          text NOT NULL,          -- e.g. PO number / invoice number
    source_version   text NOT NULL,          -- row version in the ERP (updated_at / xmin)
    row_count        int  NOT NULL,
    payload_key      text NOT NULL,          -- frozen JSON snapshot in S3
    payload_sha256   text NOT NULL,
    status           text NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'rendering', 'done', 'failed')),
    render_mode      text NOT NULL CHECK (render_mode IN ('single_pass', 'chunked')),
    attempts         int  NOT NULL DEFAULT 0,
    error            text,
    pdf_key          text,
    pdf_sha256       text,
    pdf_bytes        int,
    render_ms        int,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (job_id, seq)
);
CREATE INDEX documents_job_idx ON documents (job_id);

-- Append-only, hash-chained record of every PDF ever issued.
-- entry_hash = sha256(prev_hash | pdf_sha256 | document_id | issued_at), so editing or deleting
-- any row (even with superuser access that bypasses the trigger) breaks the chain from that point on.
CREATE TABLE pdf_ledger (
    seq          bigserial PRIMARY KEY,
    document_id  uuid NOT NULL REFERENCES documents(id),
    pdf_sha256   text NOT NULL,
    pdf_key      text NOT NULL,
    issued_at    timestamptz NOT NULL,
    prev_hash    text NOT NULL,
    entry_hash   text NOT NULL UNIQUE
);
CREATE INDEX pdf_ledger_sha_idx ON pdf_ledger (pdf_sha256);

CREATE FUNCTION pdf_ledger_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'pdf_ledger is append-only (% blocked)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pdf_ledger_no_update_delete
    BEFORE UPDATE OR DELETE ON pdf_ledger
    FOR EACH ROW EXECUTE FUNCTION pdf_ledger_append_only();
CREATE TRIGGER pdf_ledger_no_truncate
    BEFORE TRUNCATE ON pdf_ledger
    FOR EACH STATEMENT EXECUTE FUNCTION pdf_ledger_append_only();
