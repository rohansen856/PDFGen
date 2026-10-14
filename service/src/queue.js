import { SendMessageBatchCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from './clients.js';

export async function enqueue(queueUrl, documentId) {
  await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ document_id: documentId }) }));
}

export async function enqueueMany(queueUrl, documentIds) {
  for (let i = 0; i < documentIds.length; i += 10) {
    const batch = documentIds.slice(i, i + 10);
    const res = await sqs.send(new SendMessageBatchCommand({
      QueueUrl: queueUrl,
      Entries: batch.map((id, j) => ({ Id: String(j), MessageBody: JSON.stringify({ document_id: id }) })),
    }));
    if (res.Failed?.length) throw new Error(`SQS batch send failed for ${res.Failed.length} messages`);
  }
}
