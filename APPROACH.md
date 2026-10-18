# Approach Document

> **Status of this document.** I built a working local prototype (`service/`) to check the design
> rather than reason about it on paper alone. Numbers labelled **measured** come from that prototype
> (`docs/measurements/loadtest-results.json`, Intel i7-11800H laptop, worker container capped at 1 GB).
> Numbers labelled **brief** come from the problem statement. Where the two disagree, I show both and
> size for the worse one.

---

## 1. Initial Understanding

> ✏️ **DRAFT — to be rewritten in my own words.** This section is supposed to be
> my pre-AI read of the problem.

My first read: the PDF rendering itself is easy (Puppeteer + an HTML template is a solved problem),
and the actual problem is everything around it.

What I expected to be hard:

1. **The numbers don't fit together.** 1000 renders/min × 2.5 s × 400 MB means ~42 concurrent
   Chromium renders and ~17 GB of RAM at peak. The budget is $150/month and the monthly volume is only
   30,000 PDFs. Something has to give, and I needed to work out what.
2. **Large POs crashing Chromium.** Retrying the same render that just ran out of memory will just
   run out of memory again. The retry has to do something *different*.
3. **Stale data in bulk.** The 87th invoice is rendered 3 minutes after the click and shows newer
   data. That's a design flaw (rendering reads live data), not a bug to patch, so the fix has to
   come from how data reaches the renderer.
4. **Flaky downloads.** A 50 MB zip over a bad connection fails, and the user starts again from 0.
   That's a UX problem I wanted to solve with how files are served, not with retries in our code.
5. **Tamper evidence "without overcomplicating".** My instinct was digital signatures, but that
   brings certificates, an HSM, and renewal. I wanted to find the cheapest thing that holds up to an
   auditor.
6. **Integrating with a single-box Django monolith** without touching how it's deployed, and
   without letting a Chromium memory spike take down the ERP.

---

## 2. Assumptions & Clarifying Questions

### Assumptions I made

| # | Assumption | Why it matters |
|---|---|---|
| A1 | **"1000 req/min" is a short burst, not sustained.** 30,000 PDFs/month ≈ 1,000/day ≈ 1.7/min across a 10-hour business day. A sustained 1000/min would use up the whole month's volume in 30 minutes. | Decides whether we pay for peak capacity all the time (unaffordable) or rent it during bursts (Spot). |
| A2 | Bulk peaks overlap single peaks. 10 bulk req/min × 100 docs = **another 1,000 docs/min** on top of singles. | Bulk can be as heavy as all single traffic combined, so it needs its own lane or it will starve single requests. |
| A3 | Django **pushes the full document data** in the request; the PDF service has **no access to ERP tables**. | Gives a clean boundary, no coupling to the ERP schema, and consistency becomes Django's snapshot (see Decision 2). |
| A4 | Money values (totals, taxes) come **pre-computed from the ERP**. The renderer only formats them. | A PDF must never disagree with the books because of a rounding difference in a second implementation. |
| A5 | Region ap-south-1 (Mumbai), same VPC as the monolith. | Latency to the ERP, data residency, and pricing. |
| A6 | Retention is **8 years**. CGST Act s.36 / Rule 56 requires records to be kept 72 months from the due date of the annual return for that year, which works out to ~7.5 years from an April invoice. 8 years covers it. | Sets the Object Lock retention and the storage growth math. |
| A7 | An issued GST invoice is not edited in place. Corrections are credit/debit notes. | Lets us treat a rendered PDF as immutable and cache it forever by (doc, version). |
| A8 | Users are authenticated by Django; the PDF service only trusts Django (service token). | Keeps authorisation logic in one place. |
| A9 | Templates are simple (text + tables + logo); no remote fonts/images fetched at render time. | Remote assets are the #1 cause of slow and flaky Puppeteer renders. |

### Questions I'd ask before building

**Product**
1. Is 1000/min one customer or all customers? How long does a peak last (2 minutes? an hour?), and
   when does it happen? I'd guess month-end and GST due dates (GSTR-1 on the 11th, GSTR-3B on the
   20th). If peaks are predictable, scheduled scaling is cheap and reliable.
2. "Single downloads start within 5 s": p95 or p99? During a 20× burst, is it acceptable to show
   "preparing… we'll notify you" for a few seconds?
3. When a user clicks "Download" on an invoice that was edited after a previous download, should they
   get the new version (my assumption) or the originally issued one? This decides the idempotency key.
4. In a bulk request with 2 failures out of 100, do they want 98 files plus a failure list (my
   assumption) or all-or-nothing?
5. What's the maximum PO size in practice? 500+ is mentioned; are there 5,000-line POs?
6. Do invoices need an e-invoice IRN + signed QR code (see Section 7)? Any Indic-language templates?

**Compliance**
7. Is a server-side hash ledger with a `verify` endpoint enough proof, or do auditors need a digital
   signature that Adobe Reader shows by itself (PAdES)? The cost and complexity differ by roughly 10×.
8. Is 8 years right? Does anything require deletion on request (DPDP Act) that conflicts with WORM
   storage?

**Engineering**
9. Can the PDF service have its own schema on the existing RDS instance, and how many connections can
   we use? db.r6i.large is shared with the ERP.
10. Is the Redis instance configured `allkeys-lru`? (If so, it must never hold job state.)
11. Is there an existing NAT Gateway/VPC endpoint setup in that VPC? NAT is the hidden cost killer.

---

## 3. Capacity Planning & Math

### 3.1 What the brief's numbers imply

Little's law (concurrency = arrival rate × time in system):

```
Singles peak:  1000/min = 16.7 req/s
               concurrency = 16.7 × 2.5 s            = ~42 concurrent renders
               memory      = 42 × 400 MB             = ~16.8 GB
               CPU         = ~1 vCPU per active render = ~42 vCPU
Bulk peak:     10 req/min × 100 docs = up to 1000 docs/min more → another ~42 renders
Worst case:    ~84 concurrent renders, ~34 GB, ~84 vCPU
```

That's roughly 11× c7g.2xlarge-worth of compute held all the time. At Mumbai on-demand prices it
would be far beyond $150 even if it only ran during business hours. **We can't provision for peak
on always-on machines.** Either the peak is rented on demand, or it's absorbed by a queue at the
cost of latency. The design does both.

### 3.2 What I actually measured (prototype, `docs/measurements/loadtest-results.json`)

| Scenario | Time | Chromium memory (PSS) |
|---|---|---|
| **Cold** (launch Chromium per doc, 20 rows) | p50 **384 ms** | 270–375 MB peak |
| **Warm** (one browser, new tab per doc, 20 rows) | p50 **98 ms**, p95 **125 ms** | idle browser 240–350 MB, +30–90 MB per active tab |
| 1 worker process, 1 / 2 / 4 tabs | **565 / 760 / 878 docs/min** | 416 / 428 / 465 MB peak |

Large documents, single pass vs chunked (150 rows per chunk):

| Rows | Single pass: ms / extra MB / pages / KB | Chunked: ms / extra MB / pages / KB |
|---|---|---|
| 150 | 382 / +83 / 5 / 52 | — (not chunked) |
| 500 | 1,059 / **+155** / 14 / 112 | 1,332 / **+81** / 15 / 192 |
| 1,000 | 1,993 / **+304** / 26 / 197 | 2,377 / **+96** / 28 / 354 |
| 2,000 | 4,007 / **+439** / 52 / 371 | 5,320 / **+92** / 55 / 707 |

What this told me:

1. **The brief's "2–3 s, 400 MB" figure is a cold start with heavy templates.** A warm browser renders a
   typical document in ~100 ms. Reusing the browser is the single biggest efficiency win, bigger than
   any infrastructure choice. I still size for the brief's numbers (real templates have logos and
   fonts, and EC2 cores are slower than my laptop), but this shows where the 400 MB comes from:
   **~300 MB of it is the browser itself**, and that cost can be shared across renders.
2. **Single-pass memory grows ~0.22–0.3 MB per line item; chunked memory stays flat at ~90 MB.**
   This is the OOM fix, measured and not just assumed. At the brief's 400 MB/render baseline, a 500-line
   PO adds ~150 MB+ in a single tab. Several of those at once on a 4 GB box is exactly the crash
   described.
3. **Chunking isn't free.** It's ~25% slower, files are **~1.8× larger** (each chunk embeds its own
   font subset, and the merge keeps both copies), and it adds **1–3 mostly-empty pages** at chunk
   boundaries. That's why chunking is applied only above 150 rows and not to everything.
4. **More tabs barely help (565 → 878/min going from 1 to 4 tabs).** The Node main thread (pdf-lib
   merge, stamping, hashing) becomes the bottleneck. **Scale with worker processes (~1 per 2 vCPU),
   not tabs.**

### 3.3 Sizing the fleet

Per-instance throughput. Graviton per-core speed is **assumed** to be ~60% of my laptop's i7 at boost.
I haven't verified this; it's the first thing I'd measure on a real instance.

| Instance | Worker processes | Lean template (measured × 0.6) | Brief's heavy template (2.5 s, 400 MB) |
|---|---|---|---|
| c7g.large (2 vCPU, 4 GB) | 1 (+ API) | ~350 docs/min | 2 concurrent → **~48/min** |
| c7g.xlarge (4 vCPU, 8 GB) | 2 | ~700 docs/min | 4 concurrent → **~96/min** |

Memory check, c7g.xlarge with the heavy template: 2 browsers × 350 MB + 4 renders × 400 MB + 2 Node
× 150 MB ≈ **2.6 GB of 8 GB**. CPU is the bottleneck, not memory, *once large docs are chunked*.

To reach 1000 single docs/min:
- Lean templates: 1 base c7g.large + **1** c7g.xlarge Spot ≈ 1,050/min.
- Heavy templates: 1000 / 96 ≈ **11** c7g.xlarge Spot. At $0.0411/h that's **$0.45 per peak hour**.

So **Spot makes peak capacity cheap. The hard part is how fast it arrives, not what it costs.**

### 3.4 Queue depth during an unannounced burst

Heavy-template case, base instance only (48/min), burst of 1000/min hits suddenly:

```
Scale-out reaction:  SQS metric (1-min, delayed) + alarm ~2 min + launch/boot ~1.5 min + Chromium ~5 s
                     ≈ 3–4 min before the first Spot worker pulls
Backlog after 4 min: 4 × (1000 − 48)                          ≈ 3,800 messages
Drain with 11 xlarge (1,056/min) while 1000/min still arrive: +56/min net → never clears during the burst
Drain with 20 xlarge (1,920/min):                              3,800 / 920 ≈ 4 min after scale-out
```

**So: during an unannounced burst, single requests will exceed 5 s for several minutes.** The
mitigations are, in order of value:

1. **Scheduled scaling** before predictable peaks (month-end, GST due dates).
2. **Step scaling on queue depth** that jumps straight to N instances instead of adding one at a time.
3. **The `202 + job id` fallback.** The user sees "preparing" and gets the file a few seconds later
   instead of an error.
4. **A reserved slot** per worker for the high-priority queue, so bulk never pushes singles back.

With lean templates the base box alone handles ~350/min, so the problem mostly goes away. That's why
**template weight is the most important number to measure first** (Section 6).

SQS itself is effectively unbounded here: the standard queue in-flight limit is 120k and a burst
backlog is ~5k. Visibility timeout is 60 s (high) / 120 s (low), well above the worst render (2,000
rows chunked ≈ 5.3 s). The DLQ catches messages after 6 receives.

### 3.5 Storage

```
PDF size:     brief 100 KB–1 MB; measured 26–200 KB (no logo). Plan with 300 KB average.
PDFs/month:   30,000 × 300 KB                             =  9.0 GB
Snapshots:    30,000 × ~30 KB JSON (500-line PO ≈ 100 KB)  ≈  0.9 GB
              → ~10 GB/month into the archive bucket
After 8 years: 96 × 10 GB                                  ≈ 960 GB (lifecycle → Glacier IR after 90 days)
Downloads bucket: 30% of docs via bulk × 2 copies (full zip + parts) × 300 KB ≈ 5.4 GB/month,
              expired after 7 days → ~1.3 GB resident
Postgres:     ~1 KB per document (documents + ledger rows) → 30 MB/month, ~3 GB after 8 years
```

Gotcha I caught in the pricing: **Glacier IR bills a 128 KB minimum per object.** Snapshot JSONs are
mostly under that, so they're billed as 128 KB each (30k × 128 KB ≈ 3.8 GB/month billed). That's
small, but if it ever mattered, the fix would be to keep snapshots in one JSON-lines object per job.

### 3.6 Network

```
Django → API (in VPC):  1000/min × ~20 KB payload ≈ 330 KB/s at peak; a 100-doc bulk of 500-line
                        POs ≈ 10 MB in one request (fine; bodyLimit 25 MB)
User downloads:         served by S3 directly, never through our instances
                        peak 1000/min × 300 KB = 5 MB/s ≈ 40 Mbit/s from S3
Monthly egress:         9 GB singles + ~5 GB zips × ~1.3 (retries/parts) ≈ 16 GB
Instance ↔ S3:          via S3 gateway VPC endpoint → $0 and no NAT
```

### 3.7 Database connections (shared RDS)

API pool 10 + 1 LISTEN connection. Workers 10 per process. **With 20 Spot instances × 2 processes
that's 400 connections on the ERP's database, which is too many.** In production the worker pool would
be capped at 3 (a worker holds a connection only for short updates). That gives ~120 at full burst,
which is still the main reason I'd put PgBouncer in front if the burst tier grows (Section 6).

---

## 4. Design Decisions

### Decision 1: Compute — EC2 base instance + Spot burst ASG

**Alternatives considered:**
- **AWS Lambda + SQS** (my AI assistant's first recommendation). At ~$3/month for 30k renders it's the
  cheapest option, scales to 42 concurrent in seconds, and isolates each render (an OOM kills one
  invocation).
- **Co-locate on the Django r6i.large.** Free, but a Chromium OOM could take down the ERP.
- **A single fixed EC2 instance.** Simplest, but peaks just queue.
- **EC2 base + Spot ASG** (chosen).

**Chosen approach:** One always-on **c7g.large** (Graviton, on-demand) runs the API and one worker
process. A second ASG of **c7g.xlarge Spot** workers scales from 0 to N on SQS queue depth, plus
scheduled actions before known peaks. Burst instances only pull from SQS. They take no inbound
traffic, so **no load balancer is needed**.

**Why:**
- I chose EC2 over the Lambda suggestion. The main reason is **browser reuse**: measured warm vs cold
  is 98 ms vs 384 ms and ~300 MB of shared browser. Lambda cold starts with a ~60 MB compressed
  Chromium layer would eat into the 5 s budget exactly when a burst hits, and we'd be depending on a
  third-party Chromium build for Lambda.
- EC2 behaves the same locally, in CI, and in prod (one Docker image), and it's easy to debug at 2 am.
- Spot c7g.xlarge costs $0.0411/h, which is 42% of on-demand. Spot interruptions are harmless here:
  the 2-minute notice becomes SIGTERM, the worker finishes in-flight renders (<6 s), and anything
  unacknowledged returns to the queue.
- Graviton (c7g) is ~45% cheaper than the x86 equivalent in Mumbai (c7i.xlarge $0.1785/h vs
  c7g.xlarge $0.0982/h), and Chromium runs fine on arm64.

**Tradeoff accepted:**
- We pay ~$36/month for an idle base box most of the day, where Lambda would cost ~$0.
- Scale-out takes **3–4 minutes**, so an *unannounced* burst breaks the 5 s SLA for a few minutes
  (Section 3.4).
- The base instance is a single point of failure for the API. If it dies, its ASG replaces it in
  ~3–5 min. Queued work isn't lost, but single requests fail during that window.

### Decision 2: Data consistency — freeze the data at click time, render only from the frozen copy

**Alternatives considered:**
- **Workers read the ERP at render time** (what caused the GST bug). Fast to build, wrong by design.
- **Workers read the ERP "as of" a timestamp** using row versioning or temporal tables. That requires
  re-architecting the monolith's tables, which isn't allowed.
- **Lock the rows during the bulk.** That blocks users editing for minutes. No.
- **Snapshot at trigger time, pushed by Django** (chosen).

**Chosen approach:**
1. Django reads all requested documents inside **one `REPEATABLE READ` transaction**. Postgres
   guarantees every query in it sees the same committed state, and `now()` returns the transaction's
   start time, which becomes `data_as_of`.
2. It POSTs the full payloads. The API writes each one to S3 as canonical JSON with its SHA-256
   **before** the job exists, plus a job-level hash over all of them.
3. Workers render **only** from those frozen payloads, check the hash before rendering, and never touch
   the ERP.
4. Every PDF footer prints `ERP data as of <timestamp> · snapshot <hash12>`.

**Why:** Invoice #87 rendered 3 minutes later is now rendered from the same state as invoice #1, by
construction rather than by timing. The e2e test `data consistency` checks it: an edit to ₹999 made
*after* the bulk is triggered doesn't appear in the bulk's PDF (₹100), while a fresh single download
shows ₹999. The footer tells the customer *which* data they're looking at. That turns "your system
is wrong" support tickets into "this was generated before your 2:14 pm edit".

**Tradeoff accepted:**
- Bulk requests carry full data (up to ~10 MB for 100 large POs) through Django's request cycle.
- Django does the serialisation work (one transaction, a few hundred ms for 100 docs).
- A PDF reflects the click time, not the moment it was downloaded. That's correct for invoices, but it
  must be explained in the UI.
- Snapshots are stored for 8 years, which means PII retention (Section 7).

### Decision 3: Job state in Postgres (existing RDS) + SQS for work; not Redis

**Alternatives considered:**
- **The existing Redis** (BullMQ, Celery, RQ). No new infrastructure, but it's configured as a **cache**.
  With an eviction policy like `allkeys-lru`, jobs disappear silently under memory pressure. It would
  need a separate `noeviction` instance with AOF, which is a new stateful thing to run.
- **DynamoDB + SQS.** Serverless, but job status then lives outside the ERP database, and Django needs
  AWS calls just to show progress.
- **Postgres-only queue** (`SELECT … FOR UPDATE SKIP LOCKED`). Zero new services, but polling load
  lands on the ERP's database. At peak, 20 burst instances polling it is the wrong place for that load.
- **Postgres for state + SQS for delivery** (chosen).

**Chosen approach:**
- `jobs`, `documents` and `pdf_ledger` live in a separate schema on the existing RDS.
- SQS has two queues, **high** (singles) and **low** (bulk), plus a DLQ.
- Workers long-poll (20 s) and claim each document with a conditional `UPDATE … WHERE status='queued'`.
  SQS is at-least-once delivery, so duplicates simply fail to claim.
- Waiting single requests are woken by **Postgres `LISTEN/NOTIFY`**, not polling. Polling every 100 ms
  for 4 s across 40 concurrent waiters would be ~400 queries/s on the ERP's database; this is zero.

**Why:**
- Status, progress and the ledger end up in the same database Django already reads. The progress bar
  is one indexed query.
- SQS is free at this volume (well under the 1M requests/month free tier) and needs no operations work.
- Two queues plus **one slot per worker reserved for high priority** means 10 bulk jobs (1,000 docs)
  can't push a single download past its budget.

**Tradeoff accepted:**
- Two systems must agree. If the SQS send fails after the DB commit, the document stays `queued`.
  A sweeper re-enqueues anything queued for over 15 minutes (duplicates are harmless thanks to the
  conditional claim). A transactional outbox would be cleaner.
- We add load to a shared database: ~5 small writes per document, about 10,000 writes/min at the
  2,000 docs/min worst case (~170/s, comfortably within a db.r6i.large, but not free).

### Decision 4: Large POs — route by size, chunk + merge, retry differently

**Alternatives considered:**
- **Bigger memory only.** Send big docs to a big-memory worker. It postpones the crash; it doesn't
  remove it. Measured single-pass memory has no upper bound as rows grow.
- **A different renderer for big docs** (WeasyPrint/Typst). Robust, but two templates to keep looking
  identical, forever.
- **Paginate in the browser with CSS only.** Chromium still lays out the whole document in one
  renderer, so it doesn't help memory.
- **Chunk + merge** (chosen).

**Chosen approach:**
- The row count is known at enqueue. Documents with **more than 150 lines** render in 150-row chunks.
  Each chunk renders in a **fresh tab that is closed before the next opens**: header only on the first
  chunk, totals only on the last, table header repeated.
- pdf-lib merges the chunks and stamps `Page X of Y` across the whole document afterwards.
- Any retry is forced into chunked mode, because the likeliest reason a render failed is memory.
- Every render is **raced against the tab's crash event and a 30 s deadline**.
- After 2 attempts the document is marked `failed` with the error. A bulk job still completes, with a
  `failures` list in its manifest.

**Why:** Measured: chunked memory stays flat at ~90 MB for 500, 1,000 or 2,000 rows, while single pass
reaches +439 MB. The e2e test kills the Chromium renderer for real (CDP `Page.crash`) on the first
attempt and checks that the retry succeeds in chunked mode.

**Tradeoff accepted (measured, not guessed):**
- Chunked is ~25% slower.
- Files are ~1.8× larger, because each chunk embeds its own font subset.
- There are 1–3 extra, mostly empty pages where chunks end.
- Totals can't be re-checked against the rows by the renderer (by design, Assumption A4).

**Dead end worth mentioning:** my first fault injection navigated the tab to `chrome://crash`.
Chromium refuses that navigation (`ERR_ABORTED`), so the test passed while **never actually crashing
anything**. I only noticed by reading the worker logs. Switching to a real crash immediately exposed
a real bug: after a renderer crash, Puppeteer calls on that page **never resolve**, so the worker slot
hung forever. In production, every real OOM would have permanently eaten a worker slot. The
crash/deadline race in `browser.js` is the fix.

### Decision 5: Downloads for unreliable connections — presigned S3, Range, parts and a manifest

**Alternatives considered:**
- **Stream a zip from the service on the fly.** No storage, but it can't be resumed. A drop at 80%
  means starting from 0, and it ties up our instance for the whole slow download.
- **Email a link.** Fine as an addition, but it doesn't solve the drop.
- **Pre-built objects in S3, served by presigned URLs** (chosen).

**Chosen approach:** When the last document of a bulk job finishes, a worker **streams** the PDFs into:
- one full zip,
- **25-document part zips**,
- and a `manifest.json` (every file's SHA-256 + every failure).

All are uploaded to S3, and users download **directly from S3** with presigned URLs valid for 7 days.
S3 supports HTTP `Range`, so the browser's own "Resume", download managers and `curl -C -` continue
from the last byte. Per-document links let someone retry just one file. Zips use **STORE** (no
compression): PDFs are already compressed, so deflate costs CPU for ~1–3%.

**Why:** On a flaky line the worst case is losing one ~7 MB part, not a 30 MB batch. Our servers never
carry download bytes. The manifest lets a customer verify that what they received is complete and
untampered. The e2e test cuts a download at 60%, resumes with `Range`, and checks that the SHA-256 of
the result matches.

**Tradeoff accepted:**
- Bulk output is stored twice (full + parts) for 7 days. That's ~1.3 GB resident, about $0.03.
- Zipping is single-threaded on one worker at the end of the job. Measured 0.3 s for 100 docs, so
  it's fine.
- After 7 days links expire and the user must regenerate. The PDFs themselves are in the archive, so
  that's cheap.

### Decision 6: Tamper evidence — SHA-256 ledger + S3 Object Lock + `/verify` (not PAdES, yet)

**Alternatives considered:**
- **PAdES digital signature** in every PDF. The strongest option: Adobe shows "signed, unmodified" with
  no help from us. But it needs a CA-issued document-signing certificate (in India, typically a Class 3
  DSC), a key in KMS/CloudHSM (CloudHSM alone costs far more than the whole budget), signing in the hot
  path, and certificate renewal and revocation handling.
- **Store hashes only.** Cheap, but whoever can edit the database can edit the hashes.
- **Ledger + WORM storage** (chosen).

**Chosen approach:**
1. The worker hashes the final PDF bytes (SHA-256).
2. It appends a row to `pdf_ledger`, a table where a trigger **blocks UPDATE/DELETE/TRUNCATE**. Each
   row is **hash-chained** (`entry_hash = sha256(prev_hash | pdf_sha | doc_id | issued_at)`), so even a
   superuser who disables the trigger and edits a row breaks the chain from that point
   (`GET /v1/ledger/verify` finds it).
3. The PDF and the snapshot it was rendered from go to an **S3 bucket with Object Lock in COMPLIANCE
   mode** (8 years). Nobody, including the AWS root account, can delete or overwrite them.
4. `POST /v1/verify` takes any PDF and answers: did we issue exactly these bytes, when, and from which
   data snapshot?

**Why:** It costs nothing extra, has no certificates to manage, and adds no latency. To prove a PDF is
unmodified: hash it, find it in the ledger, show the identical locked original in S3. All of it is
tested end to end: one flipped byte fails verification, ledger UPDATE/DELETE are rejected, and deleting
a locked object version returns `AccessDenied`.

**Tradeoff accepted:**
- Verification needs *us*. A third party can't check a PDF offline. If compliance says auditors need
  that, PAdES is the upgrade path, and it fits cleanly as a step after rendering.
- COMPLIANCE mode is irreversible. A wrongly generated PDF stays for 8 years. That's arguably correct
  for tax records, but it must be a conscious decision (governance mode would allow privileged deletes).
- The chain is only as trustworthy as our database until we anchor it externally (Section 6).

### Decision 7: Network — no NAT Gateway, no ALB

**Alternatives considered:** Instances in private subnets with a NAT Gateway (the "best practice"
default), or an ALB in front of the API.

**Chosen approach:** Instances run in a **public subnet** with security groups. The API allows inbound
only from the Django instance's security group; workers allow **no inbound at all**. S3 is reached
through a **gateway VPC endpoint** (free). Django reaches the API through a Route 53 private DNS name.

**Why:** A NAT Gateway in Mumbai is ~$0.056/h ≈ **$41/month before data** (list price; not in the
pricing feed I pulled), more than a quarter of the budget, just to let workers reach SQS. An ALB is
$0.0239/h = $17.45/month plus LCU charges (verified) for an API with exactly one client. Neither is
needed at this scale.

**Tradeoff accepted:** Instances have public IPs ($3.65/month each, and a larger attack surface, held
closed by security groups). When the security team insists on private subnets, interface VPC endpoints
for SQS ($0.013/h ≈ $9.49/month per AZ, verified) are still cheaper than NAT.

---

## 5. AI Usage Log

> ✏️ **DRAFT — to be completed by me.** Public links go here. The list below records the moments in
> the conversation where AI output was wrong, generic, or overridden. Review it, and add my own.

**Conversation links:**
- [TODO: public link to the Claude Code session that produced the design and prototype]
- [TODO: any other conversations]

**How I used AI:** for exploring alternatives (compute options, queue choices, signing approaches), for
writing the prototype, and as a sparring partner on decisions, where I made the final call on each.
I asked it to measure instead of assume wherever possible.

**Where AI output was wrong or overridden:**

| # | What the AI said / did | What happened | Outcome |
|---|---|---|---|
| 1 | Recommended **Lambda** for rendering (cheapest, isolated). | **I chose EC2** instead. The AI then pointed out that a single EC2 box can't absorb 1000/min on budget. | EC2 base + Spot burst ASG (Decision 1). |
| 2 | Initial capacity math took the brief's **2–3 s / 400 MB per render** as fixed. | Measuring the prototype showed **~100 ms / ~90 MB** for a warm render; most of the 400 MB is the browser itself. | Capacity planned for both cases; "measure real templates" is the top follow-up. |
| 3 | Fault injection via `chrome://crash` "passed". | It never crashed anything (`ERR_ABORTED`). Caught by reading logs. A real crash exposed a **hang bug** that would have leaked a worker slot on every OOM. | Fixed in `browser.js`; the test now uses a real crash. |
| 4 | Bulk zip code used `archiver` straight into the S3 SDK. | Stream type mismatch, plus an **unhandled promise rejection that killed the worker process**. Found by the e2e suite. | Fixed. Also added `restart: unless-stopped`. |
| 5 | Pricing lookup via a third-party site returned **us-east-1 prices labelled as generic**. | Pulled AWS's own pricing JSON for Mumbai instead. | `docs/measurements/aws-prices-ap-south-1.md`. |
| 6 | Proposed MinIO as the local S3 with pinned images. | MinIO images are **no longer published** (Docker Hub and quay both denied). | Switched to RustFS, *after verifying* that it really blocks deleting a locked version. |
| 7 | Load test reported **0 pages** for every PDF. | A regex page counter, wrong because PDFs use compressed object streams. | Counts pages with pdf-lib. |
| 8 | Expected chunking to be a free win. | Measured **~1.8× file size** (duplicate font subsets) and extra blank-ish pages. | Documented as a tradeoff; chunking is only applied above 150 rows. |
| 9 | [TODO: my own catches / pushback] | | |

---

## 6. Weaknesses & Future Improvements

### Weakest parts

1. **Unannounced bursts.** Scale-out takes 3–4 minutes. With heavy templates, single requests exceed
   5 s during that window (Section 3.4). The 202 fallback makes it graceful, not fast.
2. **Throughput numbers come from a laptop.** The Graviton speed factor (×0.6) is an assumption, and the
   real templates (logos, fonts) may be heavier than mine.
3. **The ledger isn't anchored outside our own database.** A determined insider with DB superuser
   access could rewrite the *whole* chain consistently.
4. **The base instance is a single point of failure** for the API (not for queued work).
5. **Chunking side-effects:** larger files and partial pages (Decision 4).
6. **Sweeper-based recovery** of lost enqueues instead of a transactional outbox.
7. **No per-tenant fairness.** One customer submitting 10 bulk jobs delays everyone else's bulk jobs.

### With 2 more days

1. **Benchmark on a real c7g.large/xlarge with the customer's real templates.** This changes every
   sizing number. Pick the base instance size from it (c7g.large if ≤ ~500 ms per render, else xlarge).
2. **Anchor the ledger:** every hour, write the chain head hash to the Object Lock bucket. Rewriting
   history would then require defeating WORM storage, not just the database.
3. **Fix chunking's costs:** fixed row height plus page-aligned chunk sizes (no half-empty pages), and
   dedupe embedded fonts when merging.
4. **Transactional outbox** for enqueueing, and **PgBouncer** in front of RDS before the burst tier grows.
5. **Per-tenant fair queuing** for bulk (a per-tenant concurrency cap in the claim query).
6. **Observability:** p95 render time by doc size, queue age, OOM/retry rates, and DLQ depth as
   CloudWatch alarms.
7. **Template versioning:** store the template version with each document so a re-render years later is
   reproducible (Section 7).

### At 10× load (300k PDFs/month, peaks of ~10k docs/min)

- Spot burst cost scales linearly and stays cheap. 10k/min with heavy templates is ~100 c7g.xlarge
  for the peak, ~$4/peak-hour. **What breaks first is the shared RDS**, not compute: connections,
  ~50k writes/min of status updates, and LISTEN fan-out. I'd move job state to its own small RDS (or
  DynamoDB) and keep only the ledger near the ERP.
- Base tier: 2 API instances across 2 AZs behind an internal ALB. At this size the ALB's cost is
  justified.
- Reconsider **Lambda as the burst tier** (keeping EC2 as the warm base). At 10× volume, 3–4-minute ASG
  scale-out is the bottleneck, and Lambda's seconds-to-scale finally outweighs its cold starts.
- Storage reaches ~10 TB over 8 years. Glacier IR is still about $50/month; consider Deep Archive for
  docs older than 2 years if audit retrieval within 12 hours is acceptable.
- Bulk zips: build them incrementally as documents finish, instead of all at the end.

---

## 7. One Thing the Problem Statement Didn't Mention

### GST e-invoicing: the PDF isn't the legal invoice, the IRN is

Indian businesses above the e-invoicing turnover threshold (currently ₹5 crore aggregate turnover;
many of this ERP's "medium" customers will be above it) must register each B2B invoice with the
government's Invoice Registration Portal (IRP). They get back an **IRN (Invoice Reference Number)**
and a **QR code signed by the IRP**, and the printed invoice must carry that QR code. For businesses
with turnover of ₹10 crore and above, invoices must also be reported within 30 days of their date.
*(Thresholds change by notification. Verify the current values before building.)*

Why it matters for this design:

1. **Ordering dependency.** A GST invoice PDF can't be rendered until the IRN exists. The PDF service
   must **not** call the IRP itself: it's an external government API with rate limits, outages and its
   own retry semantics, and it isn't our responsibility. Django should register first, then include the
   IRN, ack number, date and signed QR payload in the snapshot. The template renders the QR locally
   (no network call at render time).
2. **Failure modes.** IRP downtime around filing deadlines is common. The UI must show "awaiting IRN"
   as a state distinct from "PDF failed", or support tickets will blame the PDF service.
3. **Bulk + consistency.** A bulk of 100 invoices may include some without IRNs yet. That's another
   reason the snapshot has to be taken by Django, which knows the rules, and why `failures` in the
   manifest needs readable reasons.
4. **Tamper evidence gets stronger.** The IRP-signed QR is itself government-issued proof of the
   invoice's key fields, which complements our hash ledger.

Two related things also didn't come up in the requirements:

- **Template versioning and reproducibility.** A re-render of a 2026 invoice in 2032 must look like
  the 2026 one. Templates should be versioned and the version stored with each document.
- **Indic fonts and the ₹ sign.** Without fonts installed in the image, Chromium silently renders
  boxes. The prototype image installs Noto fonts for this reason.
- **PII in snapshots.** Snapshots contain customer names, addresses and GSTINs, retained for 8 years
  in undeletable storage. That needs SSE-KMS encryption, tight IAM, and a DPDP Act position on erasure
  requests versus statutory retention.

---

## 8. Cost Estimation

Prices are **ap-south-1 (Mumbai)**, pulled from AWS's own public pricing feed on 2026-10-18 (sheet and
sources in `docs/measurements/aws-prices-ap-south-1.md`). ₹ uses the brief's own rate
(₹12,500 ≈ $150 → ₹83.3/$). 1 month = 730 hours.

### Baseline: 30,000 PDFs/month (lean-to-moderate templates)

| # | Item | Math | USD/month |
|---|---|---|---|
| 1 | Base EC2 c7g.large on-demand (API + 1 worker), always on | 730 h × $0.0491 | **35.84** |
| 2 | Burst EC2 c7g.xlarge **Spot** (ASG 0..N) | budget 300 instance-h (e.g. 10 instances × 1 h × 30 days) × $0.0411 | **12.33** |
| 3 | EBS gp3, base instance | 20 GB × $0.0912 | 1.82 |
| 4 | EBS gp3, Spot instances | 20 GB × $0.0912 × 300/730 | 0.75 |
| 5 | Public IPv4, base | 730 h × $0.005 | 3.65 |
| 6 | Public IPv4, Spot | 300 h × $0.005 | 1.50 |
| 7 | S3 Standard (archive, last 90 days) | ~30 GB × $0.025 | 0.75 |
| 8 | S3 Glacier IR (archive > 90 days), **year-8 worst case** | ~960 GB × $0.005 (year 1 ≈ $0.30) | 4.80 |
| 9 | S3 requests + lifecycle transitions | PUT ~65k × $0.005/1k = 0.33; GET ~100k × $0.0004/1k = 0.04; transitions 60k × $0.02/1k = 1.20 | 1.57 |
| 10 | S3 downloads bucket (7-day zips) | ~1.3 GB × $0.025 | 0.04 |
| 11 | Data transfer out to users | ~16 GB × $0.1093 (EC2↔S3 via gateway endpoint: $0) | 1.75 |
| 12 | SQS | ~0.5M requests/month (long polling) < 1M free tier | 0.00 |
| 13 | CloudWatch | logs ~0.5 GB × $0.67 + 5 alarms × $0.10 | 0.85 |
| 14 | Route 53 private hosted zone (stable API DNS) | 1 zone | 0.50 |
| 15 | RDS (existing instance) | +30 MB/month of rows; no new instance | 0.00 |
| 16 | NAT Gateway / ALB | deliberately none (Decision 7) | 0.00 |
| | **Total** | | **≈ $66 ≈ ₹5,500** |

**44% of the budget**, with ~$84 of headroom.

### Stress case: heavy templates (the brief's 2.5 s / 400 MB) + bigger bursts

| Change | USD/month |
|---|---|
| Base upgraded to c7g.xlarge on-demand (730 h × $0.0982) | 71.69 |
| Spot burst doubled to 600 instance-hours × $0.0411 | 24.66 |
| EBS (base + Spot) + IPv4 (base + Spot) | 1.82 + 1.50 + 3.65 + 3.00 = 9.97 |
| Everything else (rows 7–16, unchanged) | 10.26 |
| **Total** | **≈ $117 ≈ ₹9,700** |

Still **~78% of budget**.

### What would blow the budget, and what's already ruled out

- **NAT Gateway:** ~$41/month + $0.056/GB processed. Avoided with public subnets and an S3 gateway
  endpoint.
- **Sizing on-demand for peak:** 11 × c7g.xlarge always on ≈ $789/month. Avoided with Spot + ASG.
- **x86 instead of Graviton:** c7i.xlarge costs 1.8× c7g.xlarge.
- **PAdES with CloudHSM:** an HSM alone costs far more than $150/month. KMS-based signing would be
  ~$1/key + $0.03/10k signatures, which is affordable if compliance requires PAdES later.
- **Sustained 1000/min for real:** 43M PDFs/month. That's a different business, and the egress alone
  (~13 TB) would be ~$1,400. Assumption A1 matters.

**Savings available, not assumed above:** a 1-year Compute Savings Plan on the base instance (~30%
off). Leaving Spot hours unused, which is the likely reality at 30k PDFs/month (~1.7/min on average),
would bring the baseline closer to **$55**.
