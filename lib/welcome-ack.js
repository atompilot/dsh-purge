/**
 * 首次须知的安装器确认标记。落在当前 $DSH_HOME/dsh-purge，不进插件包。
 * 只有显式 --ack-welcome 的安装器会写；手动勾选仍只写 App 的 localStorage。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function welcomeAckPath(dshHome) {
  return join(dshHome, "dsh-purge", "welcome-ack.json");
}

export function readWelcomeAckFile(dshHome) {
  const file = welcomeAckPath(dshHome);
  if (!existsSync(file)) return { acked: false, path: file };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return {
      acked: !!(raw && raw.acked === true),
      path: file,
      at: raw && raw.at ? raw.at : null,
      source: raw && raw.source ? raw.source : null,
    };
  } catch {
    return { acked: false, path: file };
  }
}
