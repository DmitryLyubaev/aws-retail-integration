import { request } from "node:http";
export async function docker(
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath: "/var/run/docker.sock",
        path: "/v1.45" + path,
        method,
        headers: text
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(text),
            }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) {
            req.destroy(new Error("Docker response limit"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 300)
            return reject(new Error("Docker status " + res.statusCode));
          const raw = Buffer.concat(chunks);
          try {
            resolve(JSON.parse(raw.toString("utf8")));
          } catch {
            resolve(raw);
          }
        });
      },
    );
    req.setTimeout(300000, () => req.destroy(new Error("Docker deadline")));
    req.on("error", reject);
    req.end(text);
  });
}
export function streamText(raw: Buffer): string {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (
    offset + 8 <= raw.length &&
    raw[offset] <= 2 &&
    raw[offset + 1] === 0 &&
    raw[offset + 2] === 0 &&
    raw[offset + 3] === 0
  ) {
    const size = raw.readUInt32BE(offset + 4);
    chunks.push(raw.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return (offset === raw.length ? Buffer.concat(chunks) : raw).toString("utf8");
}
