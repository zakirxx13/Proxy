const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers":
    "Content-Length, Content-Range, Accept-Ranges, Content-Type",
  "Access-Control-Max-Age": "86400"
};

export async function onRequest(context) {
  const request = context.request;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }

  const requestURL = new URL(request.url);

  if (request.method !== "GET") {
    return json(
      {
        success: false,
        error: "Only GET requests are allowed"
      },
      405
    );
  }

  const target = requestURL.searchParams.get("url");

  if (!target) {
    return json(
      {
        success: false,
        error: "Missing url parameter",
        usage: "/api/proxy?url=ENCODED_M3U8_URL"
      },
      400
    );
  }

  let targetURL;

  try {
    targetURL = new URL(target);
  } catch {
    return json(
      {
        success: false,
        error: "Invalid URL"
      },
      400
    );
  }

  /*
   * Only HTTPS upstream URLs.
   */
  if (targetURL.protocol !== "https:") {
    return json(
      {
        success: false,
        error: "Only HTTPS upstream URLs are supported"
      },
      400
    );
  }

  /*
   * Basic protection against local/private targets.
   */
  if (isBlockedHost(targetURL.hostname)) {
    return json(
      {
        success: false,
        error: "Target host is not allowed"
      },
      403
    );
  }

  try {
    const upstreamRequestHeaders = new Headers();

    const range = request.headers.get("Range");

    if (range) {
      upstreamRequestHeaders.set("Range", range);
    }

    upstreamRequestHeaders.set(
      "Accept",
      "application/vnd.apple.mpegurl, application/x-mpegURL, */*"
    );

    upstreamRequestHeaders.set(
      "User-Agent",
      "Mozilla/5.0"
    );

    const upstream = await fetch(targetURL.toString(), {
      method: "GET",
      headers: upstreamRequestHeaders,
      redirect: "follow"
    });

    if (!upstream.ok) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: buildResponseHeaders(upstream.headers)
      });
    }

    const contentType =
      upstream.headers.get("content-type") || "";

    const looksLikeM3U8 =
      contentType.includes("mpegurl") ||
      contentType.includes("vnd.apple.mpegurl") ||
      targetURL.pathname.toLowerCase().includes(".m3u8");

    /*
     * If this is an M3U8 playlist,
     * rewrite its URLs.
     */
    if (looksLikeM3U8) {
      const text = await upstream.text();

      const rewritten = rewritePlaylist(
        text,
        targetURL,
        requestURL.origin
      );

      const headers = buildResponseHeaders(upstream.headers);

      headers.set(
        "Content-Type",
        "application/vnd.apple.mpegurl"
      );

      headers.set(
        "Cache-Control",
        "no-store"
      );

      return new Response(rewritten, {
        status: upstream.status,
        headers
      });
    }

    /*
     * Media segments or other resources.
     */
    const headers = buildResponseHeaders(upstream.headers);

    return new Response(upstream.body, {
      status: upstream.status,
      headers
    });

  } catch (error) {
    return json(
      {
        success: false,
        error: "Upstream request failed",
        message: error.message
      },
      502
    );
  }
}


/*
 * Rewrite HLS playlist URLs.
 */
function rewritePlaylist(
  playlist,
  baseURL,
  proxyOrigin
) {
  const lines = playlist.split(/\r?\n/);

  const output = [];

  for (const line of lines) {

    const trimmed = line.trim();

    /*
     * Empty line
     */
    if (!trimmed) {
      output.push("");
      continue;
    }

    /*
     * Comments without URI attributes.
     */
    if (trimmed.startsWith("#")) {

      /*
       * Some HLS tags contain URI="..."
       *
       * We rewrite ordinary media/playlist URI references,
       * but deliberately do not proxy encryption-key URLs.
       */
      if (
        !trimmed.startsWith("#EXT-X-KEY") &&
        !trimmed.startsWith("#EXT-X-SESSION-KEY")
      ) {
        output.push(
          rewriteURIAttributes(
            line,
            baseURL,
            proxyOrigin
          )
        );
      } else {
        output.push(line);
      }

      continue;
    }

    /*
     * Normal HLS URI line.
     *
     * Could be:
     *   variant.m3u8
     *   segment.ts
     *   segment.m4s
     *   https://...
     */
    try {
      const absolute = new URL(trimmed, baseURL);

      if (absolute.protocol !== "https:") {
        output.push(line);
        continue;
      }

      const proxyURL =
        proxyOrigin +
        "/api/proxy?url=" +
        encodeURIComponent(absolute.toString());

      output.push(proxyURL);

    } catch {
      output.push(line);
    }
  }

  return output.join("\n");
}


/*
 * Rewrite URI="..." attributes for supported HLS tags.
 */
function rewriteURIAttributes(
  line,
  baseURL,
  proxyOrigin
) {
  return line.replace(
    /URI="([^"]+)"/g,
    function(match, uri) {

      try {
        const absolute = new URL(uri, baseURL);

        if (absolute.protocol !== "https:") {
          return match;
        }

        const proxyURL =
          proxyOrigin +
          "/api/proxy?url=" +
          encodeURIComponent(absolute.toString());

        return 'URI="' + proxyURL + '"';

      } catch {
        return match;
      }
    }
  );
}


/*
 * Basic SSRF protection.
 */
function isBlockedHost(hostname) {
  const host = hostname.toLowerCase();

  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0"
  ) {
    return true;
  }

  if (
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.")
  ) {
    return true;
  }

  if (host.startsWith("172.")) {
    const parts = host.split(".");

    if (parts.length >= 2) {
      const second = Number(parts[1]);

      if (second >= 16 && second <= 31) {
        return true;
      }
    }
  }

  return false;
}


/*
 * Copy useful upstream headers
 * and add CORS.
 */
function buildResponseHeaders(upstreamHeaders) {
  const headers = new Headers();

  const allowed = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified"
  ];

  for (const name of allowed) {
    const value = upstreamHeaders.get(name);

    if (value) {
      headers.set(name, value);
    }
  }

  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }

  return headers;
}


/*
 * JSON response helper.
 */
function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        ...CORS_HEADERS
      }
    }
  );
}
