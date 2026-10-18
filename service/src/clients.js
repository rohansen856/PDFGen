import pg from 'pg';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { config } from './config.js';

const credentials = { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey };

// Small pools: this is the ERP's shared database, and burst workers multiply connections.
export const db = new pg.Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax });

export const s3 = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  credentials,
  forcePathStyle: true,
});

// Presigned URLs embed the host in the signature, so sign with the hostname clients will use.
export const s3Public = new S3Client({
  endpoint: config.s3.publicEndpoint,
  region: config.s3.region,
  credentials,
  forcePathStyle: true,
});

export const sqs = new SQSClient({
  endpoint: config.sqs.endpoint,
  region: config.s3.region,
  credentials,
});
