import { createLedger } from "../../src/ledger/contract.js";
import { unsealed } from "./ledger-fixtures.js";

/**
 * Forked by test/ledger-multiprocess.test.ts (from the compiled .test-build/). Protocol over IPC:
 *   child → parent  { type: "ready", pid }
 *   parent → child  { type: "go" }
 *   child → parent  { type: "done", pid, records: [{ id, parentRecordId, prevHash, hash }] } | { type: "error", message }
 * argv: <ledger path> <id prefix> <count>
 */
const [path, prefix, countArg] = process.argv.slice(2);
const count = Number(countArg);
const ipc = process.send?.bind(process);
if (!path || !prefix || !Number.isInteger(count) || !ipc) throw new Error("ledger-child: bad argv or no IPC channel");
const send = (m: unknown) => { ipc(m); };

const ledger = createLedger("jsonl", path);
process.on("message", async (m: { type?: string }) => {
  if (m?.type !== "go") return;
  try {
    const records: { id: string; parentRecordId: string | null; prevHash: string; hash: string }[] = [];
    for (let i = 0; i < count; i++) {
      const u = unsealed(i);
      u.id = `${prefix}-${i}`;
      u.call.callId = `${prefix}-call-${i}`;
      const r = await ledger.append(u);
      records.push({ id: r.id, parentRecordId: r.parentRecordId, prevHash: r.prevHash, hash: r.hash });
    }
    send({ type: "done", pid: process.pid, records });
  } catch (e) {
    send({ type: "error", pid: process.pid, message: e instanceof Error ? e.message : String(e) });
  } finally {
    process.disconnect?.();
  }
});
send({ type: "ready", pid: process.pid });
