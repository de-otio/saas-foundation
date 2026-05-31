/**
 * Unit tests for SqsQueue.
 *
 * Uses `aws-sdk-client-mock` to mock the SQS SDK client at the SDK boundary.
 * No real network calls.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SQSClient } from "@aws-sdk/client-sqs";
import { mockClient, type AwsClientStub } from "aws-sdk-client-mock";
import { SendMessageCommand, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { SqsQueue } from "../../src/queue/sqs-queue.js";
import { QueueBatchError } from "../../src/queue/errors.js";
import { SQS_MAX_BATCH_SIZE } from "../../src/queue/schemas.js";

const QUEUE_URL = "https://sqs.eu-central-1.amazonaws.com/123456789012/test-queue";

function makeQueue<T = unknown>(): SqsQueue<T> {
  const client = new SQSClient({});
  return new SqsQueue<T>(client, QUEUE_URL);
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

describe("SqsQueue.send", () => {
  let mock: AwsClientStub<SQSClient>;
  let queue: SqsQueue<unknown>;

  beforeEach(() => {
    mock = mockClient(SQSClient);
    queue = makeQueue();
  });

  it("sends a message with JSON-serialised body", async () => {
    mock.on(SendMessageCommand).resolves({ MessageId: "msg-1" });
    await queue.send({ event: "user.created", userId: "u-1" });

    const calls = mock.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.QueueUrl).toBe(QUEUE_URL);
    expect(JSON.parse(input.MessageBody!)).toEqual({ event: "user.created", userId: "u-1" });
  });

  it("passes delaySeconds through when provided", async () => {
    mock.on(SendMessageCommand).resolves({ MessageId: "msg-2" });
    await queue.send("ping", { delaySeconds: 30 });

    const input = mock.commandCalls(SendMessageCommand)[0]!.args[0].input;
    expect(input.DelaySeconds).toBe(30);
  });

  it("sends without delaySeconds when not provided", async () => {
    mock.on(SendMessageCommand).resolves({});
    await queue.send("ping");

    const input = mock.commandCalls(SendMessageCommand)[0]!.args[0].input;
    expect(input.DelaySeconds).toBeUndefined();
  });

  it("serialises primitive string values", async () => {
    mock.on(SendMessageCommand).resolves({});
    await queue.send("hello");
    const input = mock.commandCalls(SendMessageCommand)[0]!.args[0].input;
    expect(JSON.parse(input.MessageBody!)).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// sendBatch
// ---------------------------------------------------------------------------

describe("SqsQueue.sendBatch", () => {
  let mock: AwsClientStub<SQSClient>;
  let queue: SqsQueue<unknown>;

  beforeEach(() => {
    mock = mockClient(SQSClient);
    queue = makeQueue();
  });

  it("is a no-op for an empty array", async () => {
    await queue.sendBatch([]);
    expect(mock.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
  });

  it("sends a single batch when messages <= SQS_MAX_BATCH_SIZE", async () => {
    mock.on(SendMessageBatchCommand).resolves({ Successful: [], Failed: [] });
    const messages = Array.from({ length: 5 }, (_, i) => ({ body: { id: i } }));
    await queue.sendBatch(messages);
    expect(mock.commandCalls(SendMessageBatchCommand)).toHaveLength(1);
  });

  it("chunks oversized batches into multiple calls", async () => {
    mock.on(SendMessageBatchCommand).resolves({ Successful: [], Failed: [] });
    // SQS_MAX_BATCH_SIZE + 1 items should produce 2 calls
    const count = SQS_MAX_BATCH_SIZE + 1;
    const messages = Array.from({ length: count }, (_, i) => ({ body: i }));
    await queue.sendBatch(messages);
    expect(mock.commandCalls(SendMessageBatchCommand)).toHaveLength(2);
  });

  it("serialises message bodies to JSON", async () => {
    mock.on(SendMessageBatchCommand).resolves({ Successful: [], Failed: [] });
    await queue.sendBatch([{ body: { type: "email" } }]);
    const entries = mock.commandCalls(SendMessageBatchCommand)[0]!.args[0].input.Entries!;
    expect(JSON.parse(entries[0]!.MessageBody!)).toEqual({ type: "email" });
  });

  it("assigns sequential IDs to batch entries", async () => {
    mock.on(SendMessageBatchCommand).resolves({ Successful: [], Failed: [] });
    await queue.sendBatch([{ body: "a" }, { body: "b" }, { body: "c" }]);
    const entries = mock.commandCalls(SendMessageBatchCommand)[0]!.args[0].input.Entries!;
    expect(entries.map((e) => e.Id)).toEqual(["0", "1", "2"]);
  });

  it("passes delaySeconds per entry when provided", async () => {
    mock.on(SendMessageBatchCommand).resolves({ Successful: [], Failed: [] });
    await queue.sendBatch([{ body: "a", delaySeconds: 15 }, { body: "b" }]);
    const entries = mock.commandCalls(SendMessageBatchCommand)[0]!.args[0].input.Entries!;
    expect(entries[0]!.DelaySeconds).toBe(15);
    expect(entries[1]!.DelaySeconds).toBeUndefined();
  });

  it("throws QueueBatchError on partial failure", async () => {
    mock.on(SendMessageBatchCommand).resolves({
      Successful: [{ Id: "0", MessageId: "m1", MD5OfMessageBody: "abc" }],
      Failed: [
        {
          Id: "1",
          SenderFault: false,
          Code: "ServiceUnavailable",
          Message: "transient",
        },
      ],
    });

    await expect(queue.sendBatch([{ body: "a" }, { body: "b" }])).rejects.toThrow(QueueBatchError);
  });

  it("QueueBatchError includes the failed message IDs", async () => {
    mock.on(SendMessageBatchCommand).resolves({
      Successful: [],
      Failed: [
        { Id: "0", SenderFault: false, Code: "ServiceUnavailable", Message: "err" },
        { Id: "1", SenderFault: true, Code: "InvalidParameterValue", Message: "err2" },
      ],
    });

    let caught: QueueBatchError | undefined;
    try {
      await queue.sendBatch([{ body: "a" }, { body: "b" }]);
    } catch (e) {
      if (e instanceof QueueBatchError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught!.failedIds).toContain("0");
    expect(caught!.failedIds).toContain("1");
  });

  it("succeeds when Failed array is empty", async () => {
    mock.on(SendMessageBatchCommand).resolves({
      Successful: [{ Id: "0", MessageId: "m1", MD5OfMessageBody: "abc" }],
      Failed: [],
    });
    await expect(queue.sendBatch([{ body: "ok" }])).resolves.toBeUndefined();
  });
});
