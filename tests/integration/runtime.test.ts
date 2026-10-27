import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import { withServices } from "../support/services.js";
test("pinned Linux tools and real SQL transactions support the chosen runtime", async () =>
  withServices(async (urls) => {
    assert.equal(process.version, "v24.22.1");
    assert.match(
      execFileSync("pg_dump", ["--version"], { encoding: "utf8" }),
      /PostgreSQL\) 17\./,
    );
    assert.match(
      execFileSync("pg_restore", ["--version"], { encoding: "utf8" }),
      /PostgreSQL\) 17\./,
    );
    const db = new pg.Client(urls.database);
    await db.connect();
    try {
      assert.match(
        (await db.query("show server_version")).rows[0].server_version,
        /^17\./,
      );
      await db.query("begin");
      await db.query("create temp table probe (amount bigint)");
      await db.query("insert into probe values (2598)");
      assert.equal(
        (await db.query("select amount from probe")).rows[0].amount,
        "2598",
      );
      await db.query("rollback");
    } finally {
      await db.end();
    }
  }));
test(
  "local SQS adapter assumptions: visibility, deletion and dead-letter routing",
  { timeout: 20000 },
  async () =>
    withServices(async (urls) => {
      const client = new SQSClient({
        endpoint: urls.queue,
        region: "ap-southeast-2",
        credentials: { accessKeyId: "local", secretAccessKey: "local" },
        maxAttempts: 1,
      });
      const prefix = "runtime-" + randomUUID();
      let source: string | undefined, dlq: string | undefined;
      try {
        dlq = (
          await client.send(
            new CreateQueueCommand({ QueueName: prefix + "-dlq" }),
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
              QueueName: prefix,
              Attributes: {
                VisibilityTimeout: "1",
                RedrivePolicy: JSON.stringify({
                  deadLetterTargetArn: arn,
                  maxReceiveCount: 2,
                }),
              },
            }),
          )
        ).QueueUrl!;
        await client.send(
          new SendMessageCommand({
            QueueUrl: source,
            MessageBody: '{"synthetic":true}',
          }),
        );
        const a = (
          await client.send(new ReceiveMessageCommand({ QueueUrl: source }))
        ).Messages![0];
        assert.equal(a.Body, '{"synthetic":true}');
        await client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: source,
            ReceiptHandle: a.ReceiptHandle!,
            VisibilityTimeout: 0,
          }),
        );
        const b = (
          await client.send(new ReceiveMessageCommand({ QueueUrl: source }))
        ).Messages![0];
        assert.equal(b.MessageId, a.MessageId);
        await client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: source,
            ReceiptHandle: b.ReceiptHandle!,
            VisibilityTimeout: 0,
          }),
        );
        await client.send(new ReceiveMessageCommand({ QueueUrl: source }));
        const quarantined = (
          await client.send(
            new ReceiveMessageCommand({ QueueUrl: dlq, WaitTimeSeconds: 2 }),
          )
        ).Messages![0];
        assert.equal(quarantined.Body, a.Body);
        await client.send(
          new DeleteMessageCommand({
            QueueUrl: dlq,
            ReceiptHandle: quarantined.ReceiptHandle!,
          }),
        );
        assert.equal(
          (await client.send(new ReceiveMessageCommand({ QueueUrl: dlq })))
            .Messages?.length ?? 0,
          0,
        );
      } finally {
        if (source)
          await client.send(new DeleteQueueCommand({ QueueUrl: source }));
        if (dlq) await client.send(new DeleteQueueCommand({ QueueUrl: dlq }));
        client.destroy();
      }
    }),
);
