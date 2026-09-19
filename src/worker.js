const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "*"
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    try {
      if (url.pathname === "/api/info") {
        return json({
          success: true,
          name: "M3U8 Proxy API",
          version: "1.0.0",
          endpoint: "/api/proxy?url=ENCODED_M3U8_URL"
        });
      }

      if (url.pathname === "/api/proxy") {
        return await proxy(request, url);
      }

      return new Response(
        "M3U8 Proxy API is running.\n\nUse /api/info",
        {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            ...CORS_HEADERS
          }
        }
      );

    } catch (error) {
      return json({
        success: false,
        error: error.message
      }, 500);
    }
  }
};

async function proxy(request, requestUrl) {
  const target = requestUrl.searchParams.get("url");

  if (!target) {
    return json({
      success: false,
      error: "Missing url parameter"
    }, 400);
  }

  let targetUrl;

  try {
    targetUrl = new URL(target);
  } catch {
    return json({
      success: false,
      error: "Invalid URL"
    }, 400);
  }

  // Only HTTPS targets are accepted.
  if (targetUrl.protocol !== "https:") {
    return json({
      success: false,
      error: "Only HTTPS URLs are allowed"
    }, 400);
  }

  // Prevent requests to localhost/private/internal addresses.
  if (isBlockedHost(targetUrl.hostname)) {
    return json({
      success: false,
      error: "Target host is not allowed"
    }, 403);
  }

  const upstream = await fetch(targetUrl.toString(), {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "*/*"
    }
  });

  const headers = new Headers(upstream.headers);

  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    headers.set(key, value);
  });

  headers.set("Cache-Control", "no-store");

  return new Response(upstream.body, {
    status: upstream.status,
    headers
  });
}

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

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS
    }
  });
}
