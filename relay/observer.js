/**
 * Reads the session logs back for a human, so a run can be watched turn by turn
 * without grepping JSONL by hand.
 *
 * Lives on the relay because the logs do: they are written here (see appendLog)
 * and nowhere else. It only reads them; it never writes. Behind VOICE_LOG like
 * the rest of logging, because a transcript of what people said is not
 * something to serve unless recording was deliberately turned on.
 */
import fs from "node:fs";
import path from "node:path";

/** The sessions on disk, newest first, each summarised without being opened fully. */
export function listSessions(logDir, limit = 50) {
  let files;
  try {
    files = fs.readdirSync(logDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const rows = [];
  for (const file of files) {
    const full = path.join(logDir, file);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    // The whole point of a summary is to not read every event of every file.
    // The first user turn and a few counts come from a bounded head read.
    const head = readEvents(full, 4000);
    const session = head.find((e) => e.type === "session");
    const firstUser = head.find((e) => e.type === "response_requested")?.transcript ?? null;
    rows.push({
      id: file.replace(/\.jsonl$/, ""),
      at: session?.at ?? stat.mtime.toISOString(),
      bytes: stat.size,
      model: session?.model ?? null,
      firstUser,
    });
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** Every event of one session, oldest first. */
export function readSession(logDir, id) {
  if (!/^[\w.-]+$/.test(id)) return null; // it lands in a path; keep it boring
  const full = path.join(logDir, `${id}.jsonl`);
  if (!fs.existsSync(full)) return null;
  return readEvents(full);
}

function readEvents(full, maxBytes = Infinity) {
  let text;
  try {
    text = maxBytes === Infinity ? fs.readFileSync(full, "utf8") : headBytes(full, maxBytes);
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a line truncated by the head read; stop rather than guess
      break;
    }
  }
  return out;
}

function headBytes(full, n) {
  const fd = fs.openSync(full, "r");
  try {
    const buf = Buffer.alloc(Math.min(n, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
