import { isIndexable, NOINDEX_HEADER } from "@/lib/seo";

type FetchHandler<E, C> = (request: Request, env: E, ctx: C) => Response | Promise<Response>;

/**
 * Wrap the Worker's fetch handler: outside production (lib/seo.ts isIndexable) every response carries
 * `X-Robots-Tag: noindex, nofollow`, so no copy of the site but production is indexed, whatever the content type
 * (pages, /dev/pay, /media, API answers). Production responses pass through untouched.
 */
export function withNoindexHeader<E, C>(fetch: FetchHandler<E, C>): FetchHandler<E, C> {
  return async (request, env, ctx) => {
    const res = await fetch(request, env, ctx);
    if (isIndexable(env as { ENVIRONMENT?: string })) return res;
    try {
      res.headers.set("x-robots-tag", NOINDEX_HEADER);
      return res;
    } catch {
      // Immutable headers (a response straight from fetch()): copy it.
      const copy = new Response(res.body, res);
      copy.headers.set("x-robots-tag", NOINDEX_HEADER);
      return copy;
    }
  };
}
