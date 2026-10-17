"""
How the existing Django monolith talks to the PDF service. Drop-in module + three views; no change to
the monolith's architecture, models or deployment.

The important part is `build_snapshot`: all documents in a bulk request are read inside ONE
REPEATABLE READ transaction, so every document sees the database exactly as it was at the moment the
user clicked "generate". The service then renders only from that frozen payload and never reads the
ERP again, which is what prevents the "87th invoice shows newer data" bug.
"""
import uuid

import requests
from django.conf import settings
from django.db import connection, transaction
from django.http import HttpResponseRedirect, JsonResponse
from django.shortcuts import get_object_or_404

from erp.models import Invoice, PurchaseOrder  # existing monolith models (illustrative)
from erp.serializers import invoice_payload, purchase_order_payload  # existing to_dict-style helpers

PDF_SERVICE = settings.PDF_SERVICE_URL  # e.g. http://pdf.internal:8080
HEADERS = {"Authorization": f"Bearer {settings.PDF_SERVICE_TOKEN}"}

SERIALIZERS = {
    "invoice": (Invoice, invoice_payload),
    "purchase_order": (PurchaseOrder, purchase_order_payload),
}


def build_snapshot(doc_type, ids):
    """Read every requested document from one consistent database snapshot."""
    model, to_payload = SERIALIZERS[doc_type]
    with transaction.atomic():
        with connection.cursor() as cur:
            # Must be the first statement in the transaction. Every query below then sees the same
            # snapshot, even if other requests commit updates to these invoices meanwhile.
            cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            cur.execute("SELECT now()")  # now() = transaction start = the snapshot's point in time
            data_as_of = cur.fetchone()[0]
        rows = (
            model.objects.filter(pk__in=ids)
            .select_related("company", "party")
            .prefetch_related("line_items")
            .order_by("pk")
        )
        documents = [
            {
                "doc_type": doc_type,
                "doc_ref": obj.number,
                "source_version": obj.updated_at.isoformat(),  # or xmin; changes on every edit
                "data": to_payload(obj),  # totals come from the ERP; the PDF service never recomputes money
            }
            for obj in rows
        ]
    return data_as_of.isoformat(), documents


def download_single(request, doc_type, pk):
    """User clicks 'Download PDF'. Usually returns the file in < 1 s; never blocks > ~5 s."""
    model, _ = SERIALIZERS[doc_type]
    get_object_or_404(model.objects.for_user(request.user), pk=pk)  # permission check stays in Django
    data_as_of, [doc] = build_snapshot(doc_type, [pk])
    res = requests.post(
        f"{PDF_SERVICE}/v1/documents",
        json={"data_as_of": data_as_of, "document": doc},
        headers=HEADERS,
        timeout=6,  # service answers within ~4 s with either the file or a job id
    )
    body = res.json()
    if res.status_code == 200:
        return HttpResponseRedirect(body["download_url"])  # straight to S3, resumable
    if res.status_code == 202:
        return JsonResponse({"job_id": body["job_id"], "status": "preparing"}, status=202)
    return JsonResponse({"error": body.get("error", "PDF generation failed")}, status=502)


def start_bulk(request, doc_type):
    """User selects up to 100 documents and clicks 'Download all'."""
    ids = [int(i) for i in request.POST.getlist("ids")][:100]
    model, _ = SERIALIZERS[doc_type]
    allowed = list(model.objects.for_user(request.user).filter(pk__in=ids).values_list("pk", flat=True))
    data_as_of, documents = build_snapshot(doc_type, allowed)
    res = requests.post(
        f"{PDF_SERVICE}/v1/bulk",
        json={"data_as_of": data_as_of, "documents": documents},
        # A double-click or a client retry won't start a second job.
        headers={**HEADERS, "Idempotency-Key": request.POST.get("request_id") or str(uuid.uuid4())},
        timeout=30,
    )
    res.raise_for_status()
    job_id = res.json()["job_id"]
    request.session.setdefault("pdf_jobs", []).append(job_id)  # so only this user can poll it
    request.session.modified = True
    return JsonResponse({"job_id": job_id}, status=202)


def bulk_status(request, job_id):
    """Polled by the browser every ~2 s (or proxy /events for SSE). Returns progress, then links."""
    if job_id not in request.session.get("pdf_jobs", []):
        return JsonResponse({"error": "not found"}, status=404)
    res = requests.get(f"{PDF_SERVICE}/v1/jobs/{job_id}", headers=HEADERS, timeout=5)
    body = res.json()
    return JsonResponse(
        {
            "status": body["status"],
            "progress": body["progress"],
            # Full zip for good connections, 25-document parts for flaky ones, and per-document
            # links for retrying a single file. All are presigned S3 URLs valid for 7 days that
            # support HTTP Range, so the browser's own "Resume" works.
            "downloads": body.get("downloads"),
            "failed": [d for d in body.get("documents", []) if d["status"] == "failed"],
        }
    )
