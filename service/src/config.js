const env = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
};

export const config = {
  port: Number(env('PORT', '8080')),
  databaseUrl: env('DATABASE_URL', 'postgres://pdf:pdf@localhost:55432/pdf'),
  s3: {
    endpoint: env('S3_ENDPOINT', 'http://localhost:9000'),
    publicEndpoint: env('S3_PUBLIC_ENDPOINT', 'http://localhost:9000'),
    region: env('S3_REGION', 'ap-south-1'),
    accessKeyId: env('S3_ACCESS_KEY', 'rustfsadmin'),
    secretAccessKey: env('S3_SECRET_KEY', 'rustfsadmin'),
    archiveBucket: env('ARCHIVE_BUCKET', 'pdf-archive'),
    downloadsBucket: env('DOWNLOADS_BUCKET', 'pdf-downloads'),
  },
  sqs: {
    endpoint: env('SQS_ENDPOINT', 'http://localhost:9324'),
    highUrl: env('QUEUE_HIGH_URL', 'http://localhost:9324/000000000000/pdf-high'),
    lowUrl: env('QUEUE_LOW_URL', 'http://localhost:9324/000000000000/pdf-low'),
  },
  serviceToken: env('SERVICE_TOKEN', 'local-dev-token'),
  chromiumPath: env('CHROMIUM_PATH', '/usr/bin/chromium'),
  workerConcurrency: Number(env('WORKER_CONCURRENCY', '2')),
  dbPoolMax: Number(env('DB_POOL_MAX', '10')),
  chunkRows: Number(env('CHUNK_ROWS', '150')),
  maxRowsPerDoc: Number(env('MAX_ROWS_PER_DOC', '5000')),
  maxBulkDocs: 100,
  zipPartSize: Number(env('ZIP_PART_SIZE', '25')),
  singleWaitMs: Number(env('SINGLE_WAIT_MS', '4000')),
  renderTimeoutMs: Number(env('RENDER_TIMEOUT_MS', '30000')),
  maxAttempts: 2,
  browserRecycleAfter: Number(env('BROWSER_RECYCLE_AFTER', '200')),
  downloadUrlTtlSec: 7 * 24 * 3600,
  allowFaultInjection: env('ALLOW_FAULT_INJECTION', '0') === '1',
};
