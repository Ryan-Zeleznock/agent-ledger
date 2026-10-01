// Helpers for test/e2e-slice-1b.test.ts: a real-process runner that keeps a transcript of every byte the processes
// print (for the leak sweep), a tokenizer for the POSIX-quoted hook commands that `install-hooks --print` emits, and
// readers for the three evidence formats. Nothing here imports product code.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export interface Run { stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; ms: number; }
export interface RunOptions { cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; }

/**
 * Spawns `file argv...`, feeds `input` on stdin, closes it, and resolves at `close` (both pipes drained). Every run's
 * stdout and stderr are appended to `transcript`, so a test can later assert that a value never reached any process
 * output. A run that outlives `timeoutMs` is SIGKILLed and reported with `signal`.
 */
export function createRunner(transcript: string[]) {
  return function run(file: string, argv: string[], o: RunOptions): Promise<Run> {
    const started = Date.now();
    return new Promise<Run>((resolve) => {
      const child = spawn(file, argv, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
      child.stdin.on("error", () => { /* EPIPE: the process decided before reading; its exit code is the verdict */ });
      child.stdin.end(o.input ?? "");
      const killer = setTimeout(() => child.kill("SIGKILL"), o.timeoutMs ?? 40_000);
      child.on("close", (code, signal) => {
        clearTimeout(killer);
        transcript.push(stdout, stderr);
        resolve({ stdout, stderr, code, signal, ms: Date.now() - started });
      });
    });
  };
}

/**
 * Splits a hook `command` string the way /bin/sh would, for the restricted grammar `install-hooks --print` uses:
 * single-quoted words (with the `'\''` escape), bare `[A-Za-z0-9_-]` words, single spaces. Anything else throws, so a
 * snippet that starts relying on other shell syntax is a visible change rather than a silently mis-parsed one.
 */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < command.length) {
    if (command[i] === " ") { i++; continue; }
    let word = "";
    while (i < command.length && command[i] !== " ") {
      const c = command[i]!;
      if (c === "'") {
        const end = command.indexOf("'", i + 1);
        if (end === -1) throw new Error(`unterminated quote in hook command: ${command}`);
        word += command.slice(i + 1, end); i = end + 1;
      } else if (c === "\\") {
        word += command[i + 1] ?? ""; i += 2;
      } else if (/[A-Za-z0-9_-]/.test(c)) {
        word += c; i++;
      } else {
        throw new Error(`unexpected shell character ${JSON.stringify(c)} in hook command: ${command}`);
      }
    }
    words.push(word);
  }
  return words;
}

/** RFC 4180 reader (CRLF or LF rows, doubled quotes inside quoted cells). Returns rows of cells, header included. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * The text of the report PDF: every `(...) Tj` string, unescaped and concatenated. The writer wraps long lines at 96
 * characters, so a raw byte search could miss a value that straddles a wrap; concatenation cannot.
 */
export function pdfText(pdf: Buffer): string {
  const source = pdf.toString("latin1");
  const parts: string[] = [];
  for (const m of source.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) parts.push(m[1]!.replace(/\\([\\()])/g, "$1"));
  return parts.join("");
}

/** One JSON object per line, as the JSONL ledger stores it (spec §5). */
export function readJsonl<T>(path: string): T[] {
  const text = readFileSync(path, "utf8");
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as T);
}
