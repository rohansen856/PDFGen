import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3, s3Public } from './clients.js';
import { config } from './config.js';

export async function putObject(bucket, key, body, contentType, metadata = {}) {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, Metadata: metadata }));
}

export async function getObjectBuffer(bucket, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await res.Body.transformToByteArray());
}

export async function getObjectStream(bucket, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return res.Body;
}

// Presigned GET URLs go straight to S3, which honours HTTP Range requests, so an interrupted
// download can be resumed from the last byte (browser "Resume", curl -C -, any download manager)
// instead of restarting. The service itself never streams file bytes.
export function presign(bucket, key, filename) {
  return getSignedUrl(
    s3Public,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: filename ? `attachment; filename="${filename}"` : undefined,
    }),
    { expiresIn: config.downloadUrlTtlSec },
  );
}
