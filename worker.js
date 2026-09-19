export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    };

    // OPTIONS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    // API INFO
    if (url.pathname === "/api/info") {
      return new Response(
        JSON.stringify({
          success: true,
          name: "M3U8 Proxy API",
          version: "1.0.0",
          status: "online",
          endpoint: "/api/proxy?url=YOUR_M3U8_URL"
        }, null, 2),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json; charset=UTF-8",
            "Cache-Control": "no-store"
          }
        }
      );
    }

    // HOME
    if (url.pathname === "/") {
      return new Response(
        `M3U8 Proxy API

Status: Online

API:
${url.origin}/api/info

Proxy:
${url.origin}/api/proxy?url=YOUR_M3U8_URL`,
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "text/plain; charset=UTF-8"
          }
        }
      );
    }

    // PROXY
    if (url.pathname === "/api/proxy") {
      const target = url.searchParams.get("url");

      if (!target) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Missing url parameter"
          }, null, 2),
          {
            status: 400,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json"
            }
          }
        );
      }

      let targetURL;

      try {
        targetURL = new URL(target);
      } catch {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Invalid URL"
          }, null, 2),
          {
            status: 400,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json"
            }
          }
        );
      }

      // HTTPS only
      if (targetURL.protocol !== "https:") {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Only HTTPS URLs are allowed"
          }, null, 2),
          {
            status: 403,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json"
            }
          }
        );
      }

      try {
        const upstream = await fetch(targetURL.toString(), {
          method: "GET",
          headers: {
            "Accept": "*/*",
            "User-Agent": "Mozilla/5.0"
          }
        });

        if (!upstream.ok) {
          return new Response(
            JSON.stringify({
              success: false,
              error: "Upstream request failed",
              status: upstream.status
            }, null, 2),
            {
              status: 502,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json"
              }
            }
          );
        }

        const contentType =
          upstream.headers.get("content-type") || "";

        const isM3U8 =
          contentType.includes("mpegurl") ||
          targetURL.pathname.toLowerCase().includes(".m3u8");

        // M3U8 playlist
        if (isM3U8) {
          let text = await upstream.text();

          const baseURL = targetURL;

          text = text.split("\n").map(line => {
            const trimmed = line.trim();

            if (!trimmed || trimmed.startsWith("#")) {
              return line;
            }

            try {
              const absoluteURL =
                new URL(trimmed, baseURL).toString();

              return `${url.origin}/api/proxy?url=${encodeURIComponent(absoluteURL)}`;
            } catch {
              return line;
            }
          }).join("\n");

          return new Response(text, {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/vnd.apple.mpegurl",
              "Cache-Control": "no-cache"
            }
          });
        }

        // Media/segment
        const headers = new Headers(corsHeaders);

        const allowedHeaders = [
          "content-type",
          "content-length",
          "content-range",
          "accept-ranges",
          "etag",
          "last-modified"
        ];

        for (const name of allowedHeaders) {
          const value = upstream.headers.get(name);

          if (value) {
            headers.set(name, value);
          }
        }

        return new Response(upstream.body, {
          status: upstream.status,
          headers
        });

      } catch (error) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Proxy request failed"
          }, null, 2),
          {
            status: 502,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json"
            }
          }
        );
      }
    }

    return new Response(
      JSON.stringify({
        success: false,
        error: "Not Found"
      }, null, 2),
      {
        status: 404,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      }
    );
  }
};
