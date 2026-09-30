import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { createLedger } from "../../src/ledger/contract.js";
import { unsealed } from "./ledger-fixtures.js";

/**
 * Forked by test/ledger-multiprocess.test.ts (from the compiled .test-build/). argv: <mode> <ledger path> <prefix> <count>
 *   mode "append": on { type: "go" } appends `count` records; replies { type: "done", pid, records } and disconnects, or
 *                  { type: "blocked", pid, message } when append() fails (e.g. the lock is held) and waits for another "go".
 *   mode "hold":   on { type: "go" } takes `<path>.lock` exactly as the store does (`wx`, "<pid> <iso>") and replies
 *                  { type: "held", pid }; on { type: "release" } unlinks it, replies { type: "released" } and disconnects.
 * Every child first announces { type: "ready", pid }.
 */
const [mode, path, prefix, countArg] = process.argv.slice(2);
const count = Number(countArg ?? "0");
const ipc = process.send?.bind(process);
if (!mode || !path || !prefix || !Number.isInteger(count) || !ipc) throw new Error("ledger-child: bad argv or no IPC channel");
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
  const ledger = createLedger("jsonl", path);
  process.on("message", async (m: { type?: string }) => {
    if (m?.type !== "go") return;
    const records: { id: string; parentRecordId: string | null; prevHash: string; hash: string }[] = [];
    try {
      for (let i = 0; i < count; i++) {
        const u = unsealed(i);
        u.id = `${prefix}-${i}`;
        u.call.callId = `${prefix}-call-${i}`;
        const r = await ledger.append(u);
        records.push({ id: r.id, parentRecordId: r.parentRecordId, prevHash: r.prevHash, hash: r.hash });
      }
      send({ type: "done", pid: process.pid, records });
      process.disconnect?.();
    } catch (e) {
      send({ type: "blocked", pid: process.pid, message: e instanceof Error ? e.message : String(e), appended: records.length });
    }
  });
}
send({ type: "ready", pid: process.pid });
