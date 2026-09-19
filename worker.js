const SECRET = "k9Xm2R8vL0wP4zJ7tQ1yN5cB3eF6gH8aS1dU4iO7pM9xK2vW5zL0yN3cB6eF9gH8";

const CHANNELS = {
  "btv.m3u8": {
    name: "BTV",
    url: "https://tvsen5.aynaott.com/P3y2URgG7LDe/index.m3u8"
  },

  // Example:
  // "channel2.m3u8": {
  //   name: "Channel 2",
  //   url: "https://example.com/live/index.m3u8"
  // }
};


// ===============================
// CORS
// ===============================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*"
  };
}


// ===============================
// HMAC TOKEN
// ===============================

async function createToken(channel, expires) {

  const data = `${channel}:${expires}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );

  return btoa(
    String.fromCharCode(...new Uint8Array(signature))
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}


async function verifyToken(channel, expires, token) {

  if (!channel || !expires || !token) {
    return false;
  }

  if (Date.now() > Number(expires)) {
    return false;
  }

  const expected =
    await createToken(channel, expires);

  return token === expected;
}


// ===============================
// URL
// ===============================

function makeAbsoluteUrl(value, baseUrl) {

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}


// ===============================
// PLAYLIST REWRITE
// ===============================

function rewritePlaylist(
  playlist,
  playlistUrl,
  workerBase,
  channel,
  token,
  expires
) {

  const lines =
    playlist.split(/\r?\n/);

  return lines.map(line => {

    const trimmed = line.trim();

    if (!trimmed) {
      return line;
    }


    // #EXT-X-KEY / #EXT-X-MAP
    if (trimmed.startsWith("#")) {

      return line.replace(
        /URI="([^"]+)"/g,
        (match, uri) => {

          const absolute =
            makeAbsoluteUrl(
              uri,
              playlistUrl
            );

          if (!absolute) {
            return match;
          }

          const proxyUrl =
            `${workerBase}?url=${encodeURIComponent(absolute)}` +
            `&channel=${encodeURIComponent(channel)}` +
            `&expires=${expires}` +
            `&token=${encodeURIComponent(token)}`;

          return `URI="${proxyUrl}"`;
        }
      );
    }


    // Segment / child playlist
    const absolute =
      makeAbsoluteUrl(
        trimmed,
        playlistUrl
      );

    if (!absolute) {
      return line;
    }


    return (
      `${workerBase}?url=${encodeURIComponent(absolute)}` +
      `&channel=${encodeURIComponent(channel)}` +
      `&expires=${expires}` +
      `&token=${encodeURIComponent(token)}`
    );

  }).join("\n");
}


// ===============================
// WORKER
// ===============================

export default {

  async fetch(request) {

    const url =
      new URL(request.url);


    // OPTIONS
    if (request.method === "OPTIONS") {

      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }


    // ===============================
    // TOKEN GENERATOR
    //
    // Example:
    // /token/btv.m3u8
    // ===============================

    if (
      url.pathname.startsWith("/token/")
    ) {

      const channel =
        url.pathname
          .replace("/token/", "");


      if (!CHANNELS[channel]) {

        return new Response(
          "Channel not found",
          {
            status: 404,
            headers: corsHeaders()
          }
        );
      }


      // Token valid for 1 hour
      const expires =
        Date.now() + (60 * 60 * 1000);


      const token =
        await createToken(
          channel,
          expires
        );


      const streamUrl =
        `${url.origin}/${channel}` +
        `?expires=${expires}` +
        `&token=${token}`;


      return new Response(
        JSON.stringify({
          channel,
          expires,
          token,
          url: streamUrl
        }, null, 2),
        {
          status: 200,

          headers: {
            ...corsHeaders(),

            "Content-Type":
              "application/json"
          }
        }
      );
    }


    // ===============================
    // CHANNEL
    // ===============================

    if (
      url.pathname !== "/" &&
      !url.pathname.startsWith("/proxy")
    ) {

      const filename =
        url.pathname.replace(/^\/+/, "");


      const channel =
        CHANNELS[filename];


      if (!channel) {

        return new Response(
          "Channel not found",
          {
            status: 404,
            headers: corsHeaders()
          }
        );
      }


      const expires =
        url.searchParams.get("expires");

      const token =
        url.searchParams.get("token");


      // Token required
      if (
        !(await verifyToken(
          filename,
          expires,
          token
        ))
      ) {

        return new Response(
          "Invalid or expired token",
          {
            status: 403,
            headers: corsHeaders()
          }
        );
      }


      try {

        const response =
          await fetch(channel.url, {
            headers: {
              "User-Agent":
                "Mozilla/5.0",

              "Accept":
                "*/*"
            }
          });


        if (!response.ok) {

          return new Response(
            `Origin error: ${response.status}`,
            {
              status: 502,
              headers: corsHeaders()
            }
          );
        }


        const playlist =
          await response.text();


        const rewritten =
          rewritePlaylist(
            playlist,
            channel.url,
            `${url.origin}/proxy`,
            filename,
            token,
            expires
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

      } catch {

        return new Response(
          "Failed to fetch stream",
          {
            status: 502,
            headers: corsHeaders()
          }
        );
      }
    }


    // ===============================
    // PROXY
    // ===============================

    if (url.pathname === "/proxy") {

      const target =
        url.searchParams.get("url");

      const channel =
        url.searchParams.get("channel");

      const expires =
        url.searchParams.get("expires");

      const token =
        url.searchParams.get("token");


      if (
        !target ||
        !channel ||
        !expires ||
        !token
      ) {

        return new Response(
          "Missing parameters",
          {
            status: 400,
            headers: corsHeaders()
          }
        );
      }


      if (
        !(await verifyToken(
          channel,
          expires,
          token
        ))
      ) {

        return new Response(
          "Invalid or expired token",
          {
            status: 403,
            headers: corsHeaders()
          }
        );
      }


      const channelConfig =
        CHANNELS[channel];


      if (!channelConfig) {

        return new Response(
          "Channel not found",
          {
            status: 404,
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


      // ===============================
      // SECURITY
      // ===============================

      const allowedHost =
        new URL(
          channelConfig.url
        ).hostname;


      if (
        targetUrl.hostname !== allowedHost
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
          await fetch(
            targetUrl.toString(),
            {
              headers: {
                "User-Agent":
                  "Mozilla/5.0",

                "Accept":
                  "*/*"
              }
            }
          );


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


        // ===============================
        // M3U8
        // ===============================

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
              `${url.origin}/proxy`,
              channel,
              token,
              expires
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


        // ===============================
        // VIDEO SEGMENT
        // ===============================

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


    // ===============================
    // HOME
    // ===============================

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
