/**
 * Signing in, so the probe measures the app people actually use.
 *
 * Without a session most routes answer with a redirect to a login page, which
 * the probe correctly records as "exists" and nothing more. Every question
 * worth asking -- is this page real, what does it say about itself, what does
 * this query return, which fields does the server require -- is answered by
 * the logged-in version. Signing in roughly triples what a probe can learn
 * rather than merely polishing it.
 *
 * The sequence is described in a file rather than in arguments, because
 * credentials in a command end up in shell history.
 *
 *   {
 *     "csrf": { "url": "/api/auth/csrf", "pick": "csrfToken", "as": "csrfToken" },
 *     "post": { "url": "/api/auth/callback/credentials",
 *               "form": { "email": "pro@example.com", "password": "pro" } }
 *   }
 *
 * `csrf` is optional and covers the common case of a token that has to be
 * fetched before it can be posted back. `form` posts url-encoded, which is
 * what login endpoints overwhelmingly expect; `json` posts JSON instead.
 */

/** Cookies as a server set them, rendered as a request header. */
export function cookieJar() {
  const jar = new Map();
  return {
    absorb(setCookieHeaders = []) {
      for (const header of setCookieHeaders) {
        const [pair] = header.split(";");
        const index = pair.indexOf("=");
        if (index < 1) continue;
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        // An expired cookie is a deletion, and keeping it sends a dead session.
        if (/expires=thu, 01 jan 1970/i.test(header) || value === "") jar.delete(name);
        else jar.set(name, value);
      }
    },
    header: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
    size: () => jar.size,
  };
}

/** Reads a value out of a JSON body by dotted path. */
export function pick(body, path) {
  if (!path) return null;
  return path.split(".").reduce((value, key) => (value == null ? value : value[key]), body) ?? null;
}

/**
 * Whether signing in worked.
 *
 * A login endpoint answering 200 with an error in the body is the normal way
 * to fail, so the status alone proves nothing. What proves it is a cookie that
 * was not there before -- a session is a cookie, and if none arrived, nothing
 * happened.
 */
export function signedIn(before, after) {
  return after > before;
}
