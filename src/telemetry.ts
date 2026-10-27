import { DomainError } from "./domain/errors.js";
export const metricNames = [
  "accepted",
  "delivered",
  "retry",
  "failed",
  "outbox-pending",
] as const;
export function createTelemetry(
  sessionId: string,
  write: (s: string) => void = (s) => process.stdout.write(s),
) {
  if (!/^p14-[a-zA-Z0-9-]{1,48}$/.test(sessionId))
    throw new DomainError("invalid_session", 400);
  return {
    log(fields: {
      component: string;
      code: string;
      tenantId?: string;
      deliveryId?: string;
      generation?: number;
      attemptId?: string;
      durationMs?: number;
    }) {
      const clean: Record<string, unknown> = {
        at: new Date().toISOString(),
        SessionId: sessionId,
      };
      for (const key of [
        "component",
        "code",
        "tenantId",
        "deliveryId",
        "generation",
        "attemptId",
        "durationMs",
      ] as const) {
        const value = fields[key];
        if (
          (typeof value === "string" &&
            /^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) ||
          (typeof value === "number" && Number.isFinite(value) && value >= 0)
        )
          clean[key] = value;
      }
      write(JSON.stringify(clean) + "\n");
    },
    metrics(values: Record<(typeof metricNames)[number], number>) {
      if (metricNames.some((k) => !Number.isFinite(values[k]) || values[k] < 0))
        throw new DomainError("invalid_metric", 400);
      write(
        JSON.stringify({
          _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [
              {
                Namespace: "Portfolio/RetailIntegration",
                Dimensions: [["SessionId"]],
                Metrics: metricNames.map((Name) => ({ Name, Unit: "Count" })),
              },
            ],
          },
          SessionId: sessionId,
          ...Object.fromEntries(metricNames.map((k) => [k, values[k]])),
        }) + "\n",
      );
    },
  };
}
