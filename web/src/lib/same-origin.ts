/**
 * Whether this request came from this site's own pages.
 *
 * Two signals, because neither is present on every request. `Origin` is sent on
 * writes and on anything cross-site; `Sec-Fetch-Site` is sent by current
 * browsers on everything and says what the browser itself believed. A request
 * carrying neither is not rejected — that is a curl, an old browser or a
 * same-origin navigation, and this check is not the thing standing between the
 * account and a stranger. It removes the drive-by: a page somewhere else that
 * embeds these routes and spends the key by being visited.
 *
 * `Host` rather than `request.url`, because a TLS-terminating proxy rewrites
 * the URL to its internal origin and the comparison would then fail for every
 * legitimate visitor.
 */
export function sameOrigin(request: Request): boolean {
  const host = request.headers.get("host") ?? new URL(request.url).host
  const origin = request.headers.get("origin")
  if (origin) {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  const site = request.headers.get("sec-fetch-site")
  return !site || site === "same-origin" || site === "none"
}
