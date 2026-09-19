const CHANNELS = {
  "ATN.m3u8": {
    name: "ATN Bangla",
    url: "https://tvsen5.aynaott.com/P3y2URgG7LDe/index.m3u8"
  },

  "ETV.m3u8": {
    name: "Ekushe Tv",
    url: "https://tvsen5.aynaott.com/SyQuXz8sC3TB/index.m3u8"
  },
};


function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*"
  };
}


// Origin URL-এর relative URL-কে absolute করা
function makeAbsoluteUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}


// M3U8 playlist-এর URLগুলো Worker-এর দিকে পাঠানো
function rewritePlaylist(playlist, playlistUrl, workerBase) {

  const lines = playlist.split(/\r?\n/);

  return lines.map(line => {

    const trimmed = line.trim();

    // Empty line / comment
    if (!trimmed) {
      return line;
    }

    // #EXT-X-KEY / #EXT-X-MAP / অন্যান্য URI="..."
    if (trimmed.startsWith("#")) {

      return line.replace(
        /URI="([^"]+)"/g,
        (match, uri) => {

          const absolute = makeAbsoluteUrl(
            uri,
            playlistUrl
          );

          if (!absolute) {
            return match;
          }

          return `URI="${workerBase}?url=${encodeURIComponent(absolute)}"`;
        }
      );
    }

    // Playlist/segment URL
    const absolute = makeAbsoluteUrl(
      trimmed,
      playlistUrl
    );

    if (!absolute) {
      return line;
    }

    return `${workerBase}?url=${encodeURIComponent(absolute)}`;
  }).join("\n");
}


export default {

  async fetch(request) {

    const url = new URL(request.url);

    // OPTIONS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }


    // =====================================================
    // CHANNEL REQUEST
    // Example:
    // /btv.m3u8
    // =====================================================

    if (
      url.pathname !== "/" &&
      !url.pathname.startsWith("/proxy")
    ) {

      const filename =
        url.pathname.replace(/^\/+/, "");

      const channel = CHANNELS[filename];

      if (!channel) {

        return new Response(
          "Channel not found",
          {
            status: 404,
            headers: corsHeaders()
          }
        );
      }

      try {

        const originResponse = await fetch(
          channel.url,
          {
            headers: {
              "User-Agent": "Mozilla/5.0",
              "Accept": "*/*"
            }
          }
        );

        if (!originResponse.ok) {

          return new Response(
            `Origin error: ${originResponse.status}`,
            {
              status: 502,
              headers: corsHeaders()
            }
          );
        }


        const playlist =
          await originResponse.text();


        const workerBase =
          `${url.origin}/proxy`;


        const rewritten =
          rewritePlaylist(
            playlist,
            channel.url,
            workerBase
          );


        return new Response(
          rewritten,
          {
            status: 200,
            headers: {
              ...corsHeaders(),

              "Content-Type":
                "application/vnd.apple.mpegurl",

              "Cache-Control":
                "no-store, no-cache, must-revalidate"
            }
          }
        );

      } catch (error) {

        return new Response(
          "Failed to fetch stream",
          {
            status: 502,
            headers: corsHeaders()
          }
        );
      }
    }


    // =====================================================
    // PROXY REQUEST
    // =====================================================

    if (url.pathname === "/proxy") {

      const target =
        url.searchParams.get("url");


      if (!target) {

        return new Response(
          "Missing URL",
          {
            status: 400,
            headers: corsHeaders()
          }
        );
      }


      let targetUrl;

      try {

        targetUrl =
          new URL(target);

      } catch {

        return new Response(
          "Invalid URL",
          {
            status: 400,
            headers: corsHeaders()
          }
        );
      }


      // ---------------------------------------------------
      // SECURITY:
      // Only allow hosts configured in CHANNELS
      // ---------------------------------------------------

      const allowedHosts = new Set();

      for (const channel of Object.values(CHANNELS)) {

        try {

          allowedHosts.add(
            new URL(channel.url).hostname
          );

        } catch {}
      }


      if (
        !allowedHosts.has(
          targetUrl.hostname
        )
      ) {

        return new Response(
          "Host not allowed",
          {
            status: 403,
            headers: corsHeaders()
          }
        );
      }


      try {

        const response =
          await fetch(targetUrl.toString(), {
            headers: {
              "User-Agent": "Mozilla/5.0",
              "Accept": "*/*"
            }
          });


        if (!response.ok) {

          return new Response(
            `Origin error: ${response.status}`,
            {
              status: response.status,
              headers: corsHeaders()
            }
          );
        }


        const contentType =
          response.headers.get(
            "content-type"
          ) || "";


        // M3U8 হলে rewrite করবে
        if (
          contentType.includes(
            "mpegurl"
          ) ||
          targetUrl.pathname.endsWith(
            ".m3u8"
          )
        ) {

          const playlist =
            await response.text();


          const rewritten =
            rewritePlaylist(
              playlist,
              targetUrl.toString(),
              `${url.origin}/proxy`
            );


          return new Response(
            rewritten,
            {
              status: 200,
              headers: {
                ...corsHeaders(),

                "Content-Type":
                  "application/vnd.apple.mpegurl",

                "Cache-Control":
                  "no-store"
              }
            }
          );
        }


        // TS / M4S / অন্যান্য media
        return new Response(
          response.body,
          {
            status: response.status,
            headers: {
              ...corsHeaders(),

              "Content-Type":
                contentType ||
                "application/octet-stream",

              "Cache-Control":
                "no-store"
            }
          }
        );

      } catch {

        return new Response(
          "Proxy request failed",
          {
            status: 502,
            headers: corsHeaders()
          }
        );
      }
    }


    // =====================================================
    // HOME
    // =====================================================

    return new Response(
      "Secure M3U8 Gateway is running.",
      {
        status: 200,
        headers: {
          "Content-Type":
            "text/plain; charset=UTF-8"
        }
      }
    );
  }
};
