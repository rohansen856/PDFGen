# PDF Generation Microservice (ERP)

Design write-up plus a working local prototype for an ERP PDF service covering single and bulk
generation (up to 100 docs), resumable downloads, snapshot consistency and tamper evidence.

- **[APPROACH.md](APPROACH.md)**: the design write-up (capacity math, decisions, costs, weaknesses)
- **[architecture-diagram.png](architecture-diagram.png)** (source: [`.mmd`](architecture-diagram.mmd), vector: [`.svg`](architecture-diagram.svg))
- **[docs/measurements/](docs/measurements/)**: render timings/memory measured with the prototype and the AWS price sheet used
- **[django_client/pdf_client.py](django_client/pdf_client.py)**: how the existing Django monolith calls the service

Everything runs locally in Docker. No AWS account or cloud service is used.

| Production (AWS, ap-south-1) | Local stand-in |
|---|---|
| EC2 (API + workers) | `api`, `worker` containers (worker capped at 1 GB RAM) |
| RDS PostgreSQL (existing instance, new schema) | `postgres:16-alpine` |
| S3 with Object Lock (COMPLIANCE) | `rustfs/rustfs:1.0.3` (S3-compatible, enforces Object Lock) |
| SQS (high / low / DLQ) | `softwaremill/elasticmq-native` (SQS API) |

## Run it

```bash
docker compose up -d --build        # postgres, rustfs (+bucket init), elasticmq, api :8080, worker
curl -s localhost:8080/healthz
```

Generate a document:

```bash
cd service && npm ci
node --input-type=module -e "
import { purchaseOrder } from './fixtures/generate.js';
const r = await fetch('http://localhost:8080/v1/documents', { method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer local-dev-token' },
  body: JSON.stringify({ data_as_of: new Date().toISOString(), document: purchaseOrder({ rows: 40 }) }) });
console.log(r.status, await r.json());"
```

## Tests

```bash
cd service
npm test        # unit: snapshot hashing, ledger chain tamper detection, chunk split/merge
npm run e2e     # against the running stack (needs poppler-utils for pdftotext)
docker compose run --rm --no-deps -T worker node scripts/loadtest.js   # render cost measurements
```

The e2e suite (12 tests) covers:

- single document under 5 s
- idempotent retries
- bulk of 100 with SSE progress, full zip, 25-document parts and manifest hashes
- an interrupted zip download resumed with `Range`
- ERP edits made after a bulk trigger not leaking into its PDFs
- a 1000-row PO going through chunked rendering
- a real Chromium renderer crash, followed by an automatic chunked retry
- `/verify` accepting a genuine PDF and rejecting one with a single flipped byte
- the ledger rejecting UPDATE/DELETE
- Object Lock refusing to delete an archived PDF

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/documents` | one document; waits up to ~4 s → `200` + presigned URL, else `202` + job id |
| POST | `/v1/bulk` | ≤100 documents → `202` + job id (`Idempotency-Key` header supported) |
| GET | `/v1/jobs/:id` | progress, per-document status/links, zip + parts + manifest when done |
| GET | `/v1/jobs/:id/events` | same as SSE stream |
| POST | `/v1/verify` | body = PDF bytes → was this exact file issued by us, and when |
| GET | `/v1/ledger/verify` | recompute the whole ledger hash chain |

All endpoints except `/healthz` require `Authorization: Bearer $SERVICE_TOKEN`. Only Django calls the service directly.

## Layout

```
service/src/api.js        HTTP API, snapshot freezing, LISTEN/NOTIFY wait for single requests
service/src/worker.js     SQS consumers (priority lanes), claim/retry, chunk fallback, bulk finalisation, sweeper
service/src/render.js     templates → PDF, chunked rendering + pdf-lib merge + page stamping
service/src/browser.js    warm Chromium pool, crash/deadline handling
service/src/bulk.js       streaming STORE zips + parts + manifest
service/src/ledger.js     hash-chained ledger
service/src/db/schema.sql jobs, documents, append-only pdf_ledger
```
