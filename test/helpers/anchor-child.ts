import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { createAnchor } from "../../src/anchor/contract.js";

/**
 * Forked by test/anchor-multiprocess.test.ts (from .test-build/). argv: <mode> <anchor path> <prefix hex digit> <count>
 *   "write": on "go" writes `count` entries (hash = prefix digit repeated), replies done | blocked like ledger-child.
 *   "hold":  on "go" takes `<path>.lock` with the store's protocol, replies held; on "release" unlinks and replies released.
 */
const [mode, path, prefix, countArg] = process.argv.slice(2);
const count = Number(countArg ?? "0");
const ipc = process.send?.bind(process);
if (!mode || !path || !prefix || !Number.isInteger(count) || !ipc) throw new Error("anchor-child: bad argv or no IPC channel");
const send = (m: unknown) => { ipc(m); };

if (mode === "hold") {
  process.on("message", (m: { type?: string }) => {
    if (m?.type === "go") {
      const fd = openSync(`${path}.lock`, "wx");
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      closeSync(fd);
      send({ type: "held", pid: process.pid });
    } else if (m?.type === "release") {
      unlinkSync(`${path}.lock`);
      send({ type: "released", pid: process.pid });
      process.disconnect?.();
    }
  });
} else {
  const anchor = createAnchor("file", path);
  process.on("message", async (m: { type?: string }) => {
    if (m?.type !== "go") return;
    let written = 0;
    try {
      for (let i = 0; i < count; i++) {
        await anchor.write({ hash: prefix.repeat(64), at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() });
        written++;
      }
      send({ type: "done", pid: process.pid, written });
      process.disconnect?.();
    } catch (e) {
      send({ type: "blocked", pid: process.pid, message: e instanceof Error ? e.message : String(e), written });
    }
  });
}
send({ type: "ready", pid: process.pid });
