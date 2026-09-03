/**
 * Work out which route the model meant.
 *
 * It does not reliably send `{ path: "/settings" }`. Observed live, four of
 * five navigate calls in one session arrived as `{"/": "settings"}` and
 * `{"/": "dashboard"}` -- the route in the KEY, the schema ignored. Every one
 * failed with "Cannot read properties of undefined (reading 'pathname')", the
 * model retried the identical malformed call three times, and it eventually
 * told the user to refresh the page.
 *
 * The schema already says `path` is required and the API did not enforce it,
 * so being strict here buys nothing a user would thank us for. Navigation is
 * not destructive: the worst case is landing on the wrong page, which the next
 * sentence fixes. So read the intent out of whatever arrived.
 *
 * Deliberately NOT applied to actions. Guessing what someone meant is fine for
 * a hyperlink and not fine for a delete.
 */
export function resolveRoutePath(args, routes = []) {
  const known = routes.filter((r) => typeof r?.path === "string");

  // `path` first when it is there, then every other string in the object --
  // values before keys, since `{"/": "settings"}` carries the useful half in
  // the value and a bare "/" in the key would otherwise win.
  const candidates = [];
  if (typeof args?.path === "string") candidates.push(args.path);
  for (const value of Object.values(args ?? {})) if (typeof value === "string") candidates.push(value);
  for (const key of Object.keys(args ?? {})) if (key !== "path") candidates.push(key);

  for (const raw of candidates) {
    const text = raw.trim();
    if (!text) continue;
    const asPath = text.startsWith("/") ? text : `/${text}`;

    // An exact route.
    if (known.some((r) => r.path === asPath)) return asPath;

    // A component name: "dashboard" is the route named Dashboard, which is
    // "/" and would never be found by string matching on the path.
    const bare = text.replace(/^\//, "").toLowerCase();
    const byComponent = known.find((r) => r.component?.toLowerCase() === bare);
    if (byComponent) return byComponent.path;

    // Something path-shaped we do not recognise: a parameterised route like
    // /tasks/3 is legitimate and will not be in the list literally.
    if (text.startsWith("/")) return text;
  }
  return null;
}
