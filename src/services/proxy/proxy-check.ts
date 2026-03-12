import { logger } from "../../lib/logger";
import { getProxyPoolSnapshot, prepareProxyPool } from "../../lib/http-client";

export async function runProxyCheck(): Promise<void> {
  await prepareProxyPool("manual_proxy_check", true);
  const snapshot = getProxyPoolSnapshot();

  logger.info("Proxy check finished", {
    mode: snapshot.mode,
    configured: snapshot.configured,
    selected: snapshot.selected,
    preflightEnabled: snapshot.preflightEnabled,
    preflightCompleted: snapshot.preflightCompleted,
    capacityAt30PerProxy: snapshot.selected * 30,
  });
}
