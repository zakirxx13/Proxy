import channelsData from "./channels.json";


// ==========================================
// CONFIG
// ==========================================

// পরে এটাকে Cloudflare Secret-এ নেওয়া ভালো
const SECRET = "k9Xm2R8vL0wP4zJ7tQ1yN5cB3eF6gH8aS1dU4iO7pM9xK2vW5zL0yN3cB6eF9gH8";


// Token কতক্ষণ valid থাকবে
// 1 hour
const TOKEN_LIFETIME = 60 * 60 * 1000;


// ==========================================
// CHANNELS
// ==========================================

const CHANNELS = {};

for (const channel of channelsData.channels) {
  CHANNELS[channel.id] = channel;
}


// ==========================================
// CORS
// ==========================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*"
  };
}


// ==========================================
// HMAC
// ==========================================

async function createToken(channelId, expires) {

  const data =
    `${channelId}:${expires}`;

  const key =
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      {
        name: "HMAC",
        hash: "SHA-256"
      },
      false,
      ["sign"]
    );

  const signature =
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(data)
    );

  return btoa(
    String.fromCharCode(
      ...new Uint8Array(signature)
    )
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}


// ==========================================
// VERIFY TOKEN
// ==========================================

async function verifyToken(
  channelId,
  expires,
  token
) {

  if (
    !channelId ||
    !expires ||
    !token
  ) {
    return false;
  }


  if (
    Date.now() >= Number(expires)
  ) {
    return false;
  }


  const expected =
    await createToken(
      channelId,
      expires
    );


  return token === expected;
}


// ==========================================
// ABSOLUTE URL
// ==========================================

function makeAbsoluteUrl(
  value,
  base
) {

  try {

    return new URL(
      value,
      base
    ).toString();

  } catch {

    return null;
  }
}


// ==========================================
// REWRITE PLAYLIST
// ==========================================

function rewritePlaylist(
  playlist,
  playlistUrl,
  workerBase,
  channelId,
  token,
  expires
) {

  const lines =
    playlist.split(/\r?\n/);


  return lines.map(line => {

    const trimmed =
      line.trim();


    if (!trimmed) {
      return line;
    }


    // ======================================
    // EXT-X-KEY / EXT-X-MAP
    // ======================================

    if (
      trimmed.startsWith("#")
    ) {

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


          const proxy =
            `${workerBase}` +
            `?url=${encodeURIComponent(absolute)}` +
            `&channel=${encodeURIComponent(channelId)}` +
            `&expires=${expires}` +
            `&token=${encodeURIComponent(token)}`;


          return `URI="${proxy}"`;
        }
      );
    }


    // ======================================
    // SEGMENT / CHILD PLAYLIST
    // ======================================

    const absolute =
      makeAbsoluteUrl(
        trimmed,
        playlistUrl
      );


    if (!absolute) {
      return line;
    }


    return (
      `${workerBase}` +
      `?url=${encodeURIComponent(absolute)}` +
      `&channel=${encodeURIComponent(channelId)}` +
      `&expires=${expires}` +
      `&token=${encodeURIComponent(token)}`
    );

  }).join("\n");
}


// ==========================================
// GET CHANNEL
// ==========================================

function getChannel(id) {

  return CHANNELS[id];
}


// ==========================================
// CREATE STREAM URL
// ==========================================

async function createStreamUrl(
  requestUrl,
  channelId
) {

  const expires =
    Date.now() + TOKEN_LIFETIME;


  const token =
    await createToken(
      channelId,
      expires
    );


  return (
    `${requestUrl.origin}/${channelId}.m3u8` +
    `?expires=${expires}` +
    `&token=${encodeURIComponent(token)}`
  );
}


// ==========================================
// WORKER
// ==========================================

export default {

  async fetch(request) {

    const url =
      new URL(request.url);


    // ======================================
    // OPTIONS
    // ======================================

    if (
      request.method === "OPTIONS"
    ) {

      return new Response(
        null,
        {
          status: 204,
          headers: corsHeaders()
        }
      );
    }


    // ======================================
    // HOME
    // ======================================

    if (
      url.pathname === "/"
    ) {

      return new Response(
        JSON.stringify({
          status: "online",
          service: "Secure M3U8 Gateway",
          channels:
            Object.keys(CHANNELS).length
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


    // ======================================
    // CHANNEL LIST
    // ======================================

    if (
      url.pathname === "/channels"
    ) {

      const list =
        channelsData.channels.map(
          channel => ({
            id: channel.id,
            name: channel.name,
            group: channel.group,
            logo: channel.logo
          })
        );


      return new Response(
        JSON.stringify(
          list,
          null,
          2
        ),
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


    // ======================================
    // M3U PLAYLIST
    // ======================================

    if (
      url.pathname === "/playlist.m3u"
    ) {

      let output =
        "#EXTM3U\n";


      for (
        const channel of
        channelsData.channels
      ) {

        const streamUrl =
          await createStreamUrl(
            url,
            channel.id
          );


        output +=
          `#EXTINF:-1`;


        if (channel.logo) {

          output +=
            ` tvg-logo="${channel.logo}"`;
        }


        if (channel.group) {

          output +=
            ` group-title="${channel.group}"`;
        }


        output +=
          `,${channel.name}\n`;


        output +=
          `${streamUrl}\n`;
      }


      return new Response(
        output,
        {
          status: 200,
          headers: {
            ...corsHeaders(),

            "Content-Type":
              "application/x-mpegURL",

            "Cache-Control":
              "no-store"
          }
        }
      );
    }


    // ======================================
    // PROTECTED CHANNEL
    // ======================================

    if (
      url.pathname.endsWith(".m3u8")
    ) {

      const channelId =
        url.pathname
          .replace(/^\/+/, "")
          .replace(/\.m3u8$/, "");


      const channel =
        getChannel(channelId);


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
        url.searchParams.get(
          "expires"
        );


      const token =
        url.searchParams.get(
          "token"
        );


      const valid =
        await verifyToken(
          channelId,
          expires,
          token
        );


      if (!valid) {

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
          await fetch(
            channel.url,
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
            channelId,
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

      } catch (error) {

        return new Response(
          "Origin request failed",
          {
            status: 502,
            headers: corsHeaders()
          }
        );
      }
    }


    // ======================================
    // PROXY
    // ======================================

    if (
      url.pathname === "/proxy"
    ) {

      const target =
        url.searchParams.get(
          "url"
        );


      const channelId =
        url.searchParams.get(
          "channel"
        );


      const expires =
        url.searchParams.get(
          "expires"
        );


      const token =
        url.searchParams.get(
          "token"
        );


      if (
        !target ||
        !channelId ||
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


      const valid =
        await verifyToken(
          channelId,
          expires,
          token
        );


      if (!valid) {

        return new Response(
          "Invalid or expired token",
          {
            status: 403,
            headers: corsHeaders()
          }
        );
      }


      const channel =
        getChannel(channelId);


      if (!channel) {

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


      // ======================================
      // HOST SECURITY
      // ======================================

      const allowedHost =
        new URL(
          channel.url
        ).hostname;


      if (
        targetUrl.hostname !==
        allowedHost
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


        // ==================================
        // CHILD M3U8
        // ==================================

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
              channelId,
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


        // ==================================
        // VIDEO SEGMENT
        // ==================================

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


    // ======================================
    // 404
    // ======================================

    return new Response(
      "Not found",
      {
        status: 404,
        headers: corsHeaders()
      }
    );
  }
};
