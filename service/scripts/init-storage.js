// Idempotent bucket bootstrap. Same calls work against real S3 (run once per environment).
//   pdf-archive   : Object Lock in COMPLIANCE mode. Archived PDFs and their data snapshots can't be
//                   overwritten or deleted by anyone, root included, until retention expires.
//   pdf-downloads : bulk zips/manifests; disposable, expire after 7 days.
import {
  CreateBucketCommand, HeadBucketCommand, PutBucketLifecycleConfigurationCommand, PutObjectLockConfigurationCommand,
} from '@aws-sdk/client-s3';
import { s3 } from '../src/clients.js';
import { config } from '../src/config.js';

const retentionDays = Number(process.env.ARCHIVE_RETENTION_DAYS ?? '1'); // production: 2920 (8 years)

async function ensureBucket(Bucket, lock) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
    return false;
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket, ObjectLockEnabledForBucket: lock || undefined }));
    return true;
  }
}

for (let attempt = 1; ; attempt++) {
  try {
    await ensureBucket(config.s3.archiveBucket, true);
    await s3.send(new PutObjectLockConfigurationCommand({
      Bucket: config.s3.archiveBucket,
      ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: retentionDays } } },
    }));
    await ensureBucket(config.s3.downloadsBucket, false);
    await s3.send(new PutBucketLifecycleConfigurationCommand({
      Bucket: config.s3.downloadsBucket,
      LifecycleConfiguration: { Rules: [{ ID: 'expire-downloads', Status: 'Enabled', Filter: { Prefix: '' }, Expiration: { Days: 7 } }] },
    })).catch((e) => console.warn(`lifecycle not applied (${e.name}); fine locally`));
    console.log(`buckets ready (archive retention: COMPLIANCE ${retentionDays}d)`);
    break;
  } catch (err) {
    if (attempt >= 30) throw err;
    await new Promise((r) => setTimeout(r, 1000)); // object store still starting
  }
}
