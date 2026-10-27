export async function withServices<T>(
  run: (urls: { database: string; queue: string }) => Promise<T>,
): Promise<T> {
  const database = process.env.TEST_DATABASE_URL;
  const queue = process.env.TEST_QUEUE_ENDPOINT;
  if (!database || !queue)
    throw new Error("Run integration tests in the Compose tooling service.");
  return run({ database, queue });
}
