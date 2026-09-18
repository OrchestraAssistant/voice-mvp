/**
 * The classifier pass the catalog was built for: on a LARGE app, move the long
 * tail of operations under topics so the base prompt stays a handful of lines.
 *
 * The catalog (relay/catalog.js) ships every ROOT operation in the session
 * prompt, fully described and immediately callable, and lists only the NAMES of
 * top-level topics -- their operations are one `expand({ topic })` away. A
 * freshly generated manifest has no groups, so everything is root: exactly right
 * for a small or mid app, where shipping the whole surface costs little and
 * every tool is callable on the first turn. But a 300-operation app that way is
 * ~20k tokens of prefix paid on every response -- the size that walked a live
 * session into a per-minute rate limit.
 *
 * So above a budget, operations are clustered by their ENTITY -- the thing the
 * name acts on, read from the name itself (createIssueLink -> issue,
 * findManyApplicationRegistrations -> application, availabilityScheduleUpdate ->
 * availability). A cluster of more than one becomes a topic; a lone operation
 * stays at root, immediately callable, because a topic that holds one tool only
 * adds an expand() round trip for it. Anything already carrying a group -- from
 * a hand-correction overlay, or a future producer that knows the real structure
 * -- is left untouched; this is the floor, not the authority.
 *
 * Name-based on purpose: the accurate signal (a service class, a gql module
 * directory, a tRPC router path) lives in the producer, but reading it uniformly
 * across every stack is a bigger change, and the name already clusters well --
 * a leading verb strips to the entity, and a namespaced name keeps its
 * namespace, which is the grouping you want in both cases.
 */

// Below this many operations, ship everything at root (the deliberate default).
const ROOT_BUDGET = 40;
// A cluster is only worth a topic -- and the expand() it costs -- above one tool.
const MIN_CLUSTER = 2;

// Words that LEAD a name as a verb or qualifier rather than name the thing acted
// on. Stripped from the front so the key is the entity. A name that does not
// start with one of these keeps its first word (for `availabilityScheduleUpdate`
// that is `availability` -- the namespace, which is the grouping you want).
const LEAD = new Set([
  "get", "list", "find", "fetch", "read", "load", "show", "view", "search", "count",
  "create", "add", "new", "insert", "upsert", "make", "generate", "import",
  "update", "patch", "edit", "set", "change", "modify", "save", "rename",
  "delete", "remove", "destroy", "clear", "drop", "discard", "purge", "wipe",
  "archive", "unarchive", "restore", "deactivate", "activate", "disable", "enable",
  "cancel", "revoke", "reset", "toggle", "assign", "unassign", "approve", "reject",
  "submit", "send", "mark", "move", "reorder", "duplicate", "copy", "bulk", "batch",
  "one", "many", "all", "current", "my",
]);

/** camelCase / dotted / dashed name -> its words. */
function words(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/** The topic key for an operation: its entity, after stripping leading verbs. */
export function groupKeyOf(name) {
  const ws = words(name);
  if (!ws.length) return "";
  let i = 0;
  // Skip leading verbs AND single-character fragments (`oAuthCreateClient` splits
  // to o/Auth/... -> "auth", not "o"). Never strip the last word, so an all-verb
  // name still yields a key.
  while (i < ws.length - 1 && (ws[i].length === 1 || LEAD.has(ws[i].toLowerCase()))) i++;
  return ws[i].toLowerCase();
}

export const grouping = {
  name: "grouping",
  role: "policy",
  describe: "on a large app, cluster operations into topics by entity so the base prompt stays small",

  // A policy: reads the MERGED manifest, after producers/enrichers and after
  // infrastructure has dropped what it drops, so it only groups surviving ops.
  run({ manifest }) {
    const ops = [...(manifest?.queries ?? []), ...(manifest?.actions ?? [])];
    if (ops.length <= ROOT_BUDGET) return { notes: [] };

    // Count clusters among operations that do not already carry a group.
    const counts = new Map();
    for (const op of ops) {
      if (op.group?.length) continue;
      const key = groupKeyOf(op.name);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    let grouped = 0;
    const topics = new Set();
    for (const op of ops) {
      if (op.group?.length) continue;
      const key = groupKeyOf(op.name);
      if (key && counts.get(key) >= MIN_CLUSTER) {
        op.group = [key];
        topics.add(key);
        grouped += 1;
      }
    }

    if (!grouped) return { notes: [] };
    const shown = [...topics].sort((a, b) => counts.get(b) - counts.get(a)).slice(0, 8);
    return {
      notes: [
        `grouping: ${ops.length} operations -> ${ops.length - grouped} at root + ` +
          `${grouped} under ${topics.size} topic(s) (${shown.join(", ")}${topics.size > 8 ? ", ..." : ""})`,
      ],
    };
  },
};
