import {
  ECSClient,
  DescribeClustersCommand,
  DescribeServicesCommand,
  ListTasksCommand,
  DescribeTasksCommand,
  UpdateServiceCommand,
  StopTaskCommand,
} from "@aws-sdk/client-ecs";
import {
  RDSClient,
  DescribeDBInstancesCommand,
  ListTagsForResourceCommand,
  DeleteDBInstanceCommand,
} from "@aws-sdk/client-rds";
import { DomainError } from "../domain/errors.js";
export interface CleanupInput {
  sessionId: string;
  clusterArn: string;
  serviceArns: readonly string[];
  dbIdentifier: string;
}
export interface CleanupClients {
  inspectCluster(arn: string): Promise<{ sessionId?: string } | null>;
  inspectService(arn: string): Promise<{ sessionId?: string } | null>;
  scaleZero(arn: string): Promise<void>;
  listTasks(clusterArn: string): Promise<string[]>;
  inspectTask(
    arn: string,
  ): Promise<{ sessionId?: string; clusterArn: string } | null>;
  stopTask(arn: string): Promise<void>;
  inspectDatabase(
    id: string,
  ): Promise<{ sessionId?: string; status: string } | null>;
  deleteDatabase(id: string): Promise<void>;
}
export interface CleanupSummary {
  servicesScaled: number;
  tasksStopped: number;
  databaseAbsent: boolean;
  fullTeardown: false;
}
export async function cleanupCostDrivers(
  input: CleanupInput,
  clients: CleanupClients,
): Promise<CleanupSummary> {
  const match =
    /^arn:aws:ecs:ap-southeast-2:(\d{12}):cluster\/(p14-[a-z0-9-]{1,40})$/.exec(
      input.clusterArn,
    );
  if (
    !match ||
    match[2] !== input.sessionId ||
    input.dbIdentifier !== input.sessionId ||
    input.serviceArns.length !== 2 ||
    new Set(input.serviceArns).size !== 2 ||
    !["application", "worker"].every((name) =>
      input.serviceArns.includes(
        `arn:aws:ecs:ap-southeast-2:${match[1]}:service/${input.sessionId}/${input.sessionId}-${name}`,
      ),
    )
  )
    throw new DomainError("cleanup_inventory", 400);
  const owned = (value: { sessionId?: string } | null) => {
    if (value && value.sessionId !== input.sessionId)
      throw new DomainError("cleanup_ownership", 409);
  };
  const cluster = await clients.inspectCluster(input.clusterArn);
  owned(cluster);
  const services = cluster
    ? await Promise.all(
        input.serviceArns.map((arn) => clients.inspectService(arn)),
      )
    : [null, null];
  services.forEach(owned);
  const tasks = cluster ? await clients.listTasks(input.clusterArn) : [];
  if (tasks.length > 10) throw new DomainError("cleanup_inventory", 409);
  const taskPrefix = `arn:aws:ecs:ap-southeast-2:${match[1]}:task/${input.sessionId}/`;
  for (const arn of tasks) {
    if (
      !arn.startsWith(taskPrefix) ||
      !/^[-a-zA-Z0-9]+$/.test(arn.slice(taskPrefix.length))
    )
      throw new DomainError("cleanup_inventory", 409);
    const task = await clients.inspectTask(arn);
    owned(task);
    if (task && task.clusterArn !== input.clusterArn)
      throw new DomainError("cleanup_ownership", 409);
  }
  const database = await clients.inspectDatabase(input.dbIdentifier);
  owned(database);
  const result: CleanupSummary = {
    servicesScaled: 0,
    tasksStopped: 0,
    databaseAbsent: !database,
    fullTeardown: false,
  };
  for (let i = 0; i < services.length; i++)
    if (services[i]) {
      await clients.scaleZero(input.serviceArns[i]);
      result.servicesScaled++;
    }
  for (const arn of tasks) {
    await clients.stopTask(arn);
    result.tasksStopped++;
  }
  if (database) {
    if (database.status !== "deleting")
      await clients.deleteDatabase(input.dbIdentifier);
    result.databaseAbsent = !(await clients.inspectDatabase(
      input.dbIdentifier,
    ));
  }
  if (!result.databaseAbsent) throw new DomainError("cleanup_incomplete", 503);
  return result;
}
export function awsCleanupClients(region = "ap-southeast-2"): CleanupClients {
  const ecs = new ECSClient({ region, maxAttempts: 2 }),
    rds = new RDSClient({ region, maxAttempts: 2 });
  const tags = (
    items: readonly { key?: string; value?: string }[] | undefined,
  ) => items?.find((t) => t.key === "SessionId")?.value;
  const signal = () => AbortSignal.timeout(8000);
  return {
    async inspectCluster(cluster) {
      const r = await ecs.send(
        new DescribeClustersCommand({ clusters: [cluster], include: ["TAGS"] }),
        { abortSignal: signal() },
      );
      if (r.failures?.some((f) => f.reason !== "MISSING"))
        throw new DomainError("cleanup_inspect", 503);
      return r.clusters?.[0] ? { sessionId: tags(r.clusters[0].tags) } : null;
    },
    async inspectService(service) {
      const cluster = service
        .replace(":service/", ":cluster/")
        .split("/")
        .slice(0, 2)
        .join("/");
      const r = await ecs.send(
        new DescribeServicesCommand({
          cluster,
          services: [service],
          include: ["TAGS"],
        }),
        { abortSignal: signal() },
      );
      if (r.failures?.some((f) => f.reason !== "MISSING"))
        throw new DomainError("cleanup_inspect", 503);
      const s = r.services?.[0];
      return s && s.status !== "INACTIVE" ? { sessionId: tags(s.tags) } : null;
    },
    async scaleZero(service) {
      const cluster = service
        .replace(":service/", ":cluster/")
        .split("/")
        .slice(0, 2)
        .join("/");
      await ecs.send(
        new UpdateServiceCommand({ cluster, service, desiredCount: 0 }),
        { abortSignal: signal() },
      );
    },
    async listTasks(cluster) {
      const r = await ecs.send(
        new ListTasksCommand({ cluster, maxResults: 100 }),
        { abortSignal: signal() },
      );
      if (r.nextToken) throw new DomainError("cleanup_inventory", 409);
      return r.taskArns ?? [];
    },
    async inspectTask(task) {
      const cluster = task
        .replace(":task/", ":cluster/")
        .split("/")
        .slice(0, 2)
        .join("/");
      const r = await ecs.send(
        new DescribeTasksCommand({ cluster, tasks: [task], include: ["TAGS"] }),
        { abortSignal: signal() },
      );
      if (r.failures?.some((f) => f.reason !== "MISSING"))
        throw new DomainError("cleanup_inspect", 503);
      return r.tasks?.[0]
        ? {
            sessionId: tags(r.tasks[0].tags),
            clusterArn: r.tasks[0].clusterArn ?? "",
          }
        : null;
    },
    async stopTask(task) {
      const cluster = task
        .replace(":task/", ":cluster/")
        .split("/")
        .slice(0, 2)
        .join("/");
      await ecs.send(
        new StopTaskCommand({
          cluster,
          task,
          reason: "Bounded portfolio session cleanup",
        }),
        { abortSignal: signal() },
      );
    },
    async inspectDatabase(DBInstanceIdentifier) {
      try {
        const r = await rds.send(
          new DescribeDBInstancesCommand({ DBInstanceIdentifier }),
          { abortSignal: signal() },
        );
        const d = r.DBInstances?.[0];
        if (!d) return null;
        const t = await rds.send(
          new ListTagsForResourceCommand({ ResourceName: d.DBInstanceArn! }),
          { abortSignal: signal() },
        );
        return {
          sessionId: t.TagList?.find((t) => t.Key === "SessionId")?.Value,
          status: d.DBInstanceStatus ?? "unknown",
        };
      } catch (e) {
        if ((e as { name?: string }).name === "DBInstanceNotFoundFault")
          return null;
        throw e;
      }
    },
    async deleteDatabase(DBInstanceIdentifier) {
      await rds.send(
        new DeleteDBInstanceCommand({
          DBInstanceIdentifier,
          SkipFinalSnapshot: true,
          DeleteAutomatedBackups: true,
        }),
        { abortSignal: signal() },
      );
    },
  };
}
export async function handler(_event: unknown) {
  const input = JSON.parse(process.env.CLEANUP_CONFIG ?? "{}") as CleanupInput;
  try {
    const result = await cleanupCostDrivers(input, awsCleanupClients());
    process.stdout.write(
      JSON.stringify({
        component: "cleanup",
        code: "cost_drivers_removed",
        ...result,
      }) + "\n",
    );
    return result;
  } catch (e) {
    process.stderr.write(
      JSON.stringify({
        component: "cleanup",
        code: e instanceof DomainError ? e.code : "cleanup_failed",
      }) + "\n",
    );
    throw new Error(
      "Cleanup incomplete; inspect the bounded code and reconcile the owned inventory.",
    );
  }
}
