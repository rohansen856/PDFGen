# AWS prices used in the cost estimate (ap-south-1, Mumbai)

Pulled on 2026-10-18 from AWS's public pricing JSON (the same feed the aws.amazon.com pricing pages
use), publication date `2026-10-15T19:13:16Z`:

- `b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/Asia Pacific (Mumbai)/Linux/index.json`
- `website.spot.ec2.aws.a2z.com/spot.js` (spot, point-in-time)
- `b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/s3/USD/current/s3.json`
- `b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/datatransfer/USD/current/datatransfer.json`

| Item | USD |
|---|---|
| c7g.large on-demand (2 vCPU, 4 GiB) | 0.0491 / hr |
| c7g.xlarge on-demand (4 vCPU, 8 GiB) | 0.0982 / hr |
| c7g.large spot | 0.0258 / hr |
| c7g.xlarge spot | 0.0411 / hr |
| c7i.xlarge on-demand (x86, for comparison) | 0.1785 / hr |
| t4g.large on-demand (burstable) | 0.0448 / hr |
| S3 Standard (first 50 TB) | 0.025 / GB-month |
| S3 Standard-IA | 0.0138 / GB-month |
| S3 Glacier Instant Retrieval | 0.005 / GB-month |
| S3 Glacier Flexible Retrieval | 0.0045 / GB-month |
| S3 PUT/COPY/POST/LIST | 0.005 / 1,000 |
| S3 GET | 0.0004 / 1,000 |
| Lifecycle transition into Glacier IR | 0.02 / 1,000 |
| Internet egress (after free tier, first 10 TB) | 0.1093 / GB |

Not re-verified from the feed (taken from AWS's published list prices; treat as approximate):
EBS gp3 ~0.0912/GB-month in Mumbai, public IPv4 0.005/hr, SQS 0.40 per million after the
permanent 1M/month free tier, CloudWatch Logs ingestion ~0.67/GB, Route 53 private hosted zone 0.50/month.
