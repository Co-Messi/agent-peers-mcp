// shared/ensure-broker.ts
// Ensures the broker daemon is running. Spawns it detached if not.

import { fileURLToPath } from "node:url";
import type { BrokerClient } from "./broker-client.ts";

export async function ensureBroker(
  client: BrokerClient,
  brokerScriptUrl: string, // pass `new URL("./broker.ts", import.meta.url).href`
): Promise<void> {
  if (await client.isAlive()) return;

  // Resolve via fileURLToPath — required because the project path contains a space
  // AND an apostrophe ("Brayden's Projects"). URL.pathname returns URL-encoded
  // (%27, %20). fileURLToPath decodes to actual filesystem form; spawn would
  // ENOENT the encoded form.
  const scriptPath = fileURLToPath(brokerScriptUrl);

  const proc = Bun.spawn(["bun", scriptPath], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await client.isAlive()) return;
  }
  throw new Error("ensureBroker: broker did not come up within 6s");
}
