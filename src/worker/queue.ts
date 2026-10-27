import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import type { QueueEnvelope } from "../domain/delivery.js";
import { DomainError } from "../domain/errors.js";
export interface QueueMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  receiveCount: number;
}
export interface QueueConfig {
  mode: "local" | "aws";
  region: string;
  sourceUrl: string;
  dlqUrl: string;
  localEndpoint?: string;
}
export interface Queue {
  send(envelope: QueueEnvelope): Promise<void>;
  receive(kind: "source" | "dlq"): Promise<QueueMessage[]>;
  remove(kind: "source" | "dlq", receiptHandle: string): Promise<void>;
  defer(receiptHandle: string, seconds: number): Promise<void>;
  close(): void;
}
export function createQueue(config: QueueConfig): Queue {
  const source = new URL(config.sourceUrl),
    dlq = new URL(config.dlqUrl);
  if (source.href === dlq.href)
    throw new DomainError("invalid_queue_config", 500);
  if (config.mode === "local") {
    if (
      !config.localEndpoint ||
      [source.origin, dlq.origin].some(
        (x) => x !== new URL(config.localEndpoint!).origin,
      )
    )
      throw new DomainError("invalid_queue_config", 500);
  } else if (
    config.localEndpoint ||
    [source, dlq].some(
      (x) =>
        x.protocol !== "https:" ||
        x.hostname !== `sqs.${config.region}.amazonaws.com`,
    )
  )
    throw new DomainError("invalid_queue_config", 500);
  const closed = new AbortController();
  const signal = (ms: number) =>
    AbortSignal.any([closed.signal, AbortSignal.timeout(ms)]);
  const client = new SQSClient({
    region: config.region,
    maxAttempts: 1,
    ...(config.mode === "local"
      ? {
          endpoint: config.localEndpoint,
          credentials: { accessKeyId: "local", secretAccessKey: "local" },
        }
      : {}),
  });
  const url = (kind: "source" | "dlq") =>
    kind === "source" ? config.sourceUrl : config.dlqUrl;
  return {
    async send(envelope) {
      await client.send(
        new SendMessageCommand({
          QueueUrl: config.sourceUrl,
          MessageBody: JSON.stringify(envelope),
        }),
        { abortSignal: signal(5000) },
      );
    },
    async receive(kind) {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: url(kind),
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
        { abortSignal: signal(25000) },
      );
      return (response.Messages ?? []).map((m) => ({
        messageId: m.MessageId ?? "",
        receiptHandle: m.ReceiptHandle ?? "",
        body: m.Body ?? "",
        receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? "1"),
      }));
    },
    async remove(kind, receiptHandle) {
      await client.send(
        new DeleteMessageCommand({
          QueueUrl: url(kind),
          ReceiptHandle: receiptHandle,
        }),
        { abortSignal: signal(5000) },
      );
    },
    async defer(receiptHandle, seconds) {
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 43200)
        throw new DomainError("invalid_visibility", 500);
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: config.sourceUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: seconds,
        }),
        { abortSignal: signal(5000) },
      );
    },
    close() {
      closed.abort();
      client.destroy();
    },
  };
}
