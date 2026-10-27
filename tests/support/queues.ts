import { randomUUID } from "node:crypto";
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  DeleteQueueCommand,
} from "@aws-sdk/client-sqs";
import {
  createQueue,
  type Queue,
  type QueueConfig,
} from "../../src/worker/queue.js";
export async function withQueues<T>(
  run: (queue: Queue, config: QueueConfig, client: SQSClient) => Promise<T>,
): Promise<T> {
  const endpoint = process.env.TEST_QUEUE_ENDPOINT;
  if (!endpoint) throw new Error("Compose queue required");
  const client = new SQSClient({
    endpoint,
    region: "ap-southeast-2",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
    maxAttempts: 1,
  });
  const name = "p14-" + randomUUID();
  let dlq: string | undefined, source: string | undefined;
  let queue: Queue | undefined;
  try {
    dlq = (
      await client.send(
        new CreateQueueCommand({
          QueueName: name + "-dlq",
          Attributes: { MessageRetentionPeriod: "345600" },
        }),
      )
    ).QueueUrl!;
    const arn = (
      await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: dlq,
          AttributeNames: ["QueueArn"],
        }),
      )
    ).Attributes!.QueueArn;
    source = (
      await client.send(
        new CreateQueueCommand({
          QueueName: name,
          Attributes: {
            VisibilityTimeout: "45",
            ReceiveMessageWaitTimeSeconds: "20",
            MessageRetentionPeriod: "86400",
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: arn,
              maxReceiveCount: 5,
            }),
          },
        }),
      )
    ).QueueUrl!;
    const config: QueueConfig = {
      mode: "local",
      region: "ap-southeast-2",
      localEndpoint: endpoint,
      sourceUrl: source,
      dlqUrl: dlq,
    };
    queue = createQueue(config);
    return await run(queue, config, client);
  } finally {
    queue?.close();
    if (source) await client.send(new DeleteQueueCommand({ QueueUrl: source }));
    if (dlq) await client.send(new DeleteQueueCommand({ QueueUrl: dlq }));
    client.destroy();
  }
}
