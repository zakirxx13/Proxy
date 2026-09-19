const SECRET = "CHANGE_THIS_TO_A_LONG_RANDOM_SECRET";

// নিজের/অনুমোদিত M3U8 লিংকগুলো এখানে রাখবে
const CHANNELS = {
  "1": {
    name: "Channel 1",
    url: "https://YOUR-ORIGIN.com/channel1/index.m3u8"
  },

  "2": {
    name: "Channel 2",
    url: "https://YOUR-ORIGIN.com/channel2/index.m3u8"
  },

  "3": {
    name: "Channel 3",
    url: "https://YOUR-ORIGIN.com/channel3/index.m3u8"
  }

  // একইভাবে 100+ channel যোগ করতে পারবে
};


export default {
  async fetch(request) {

    try {

      const url = new URL(request.url);

      // -------------------------
      // CORS
      // -------------------------
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders()
        });
      }

      // -------------------------
      // GET only
      // -------------------------
      if (request.method !== "GET") {
        return jsonError("GET only", 405);
      }


      // ==================================================
      // TOKEN GENERATOR
      // ==================================================
      //
      // Example:
      //
      // /token/1?secret=YOUR_SECRET
      //
      // ==================================================

      if (url.pathname.startsWith("/token/")) {

        const channelId =
          url.pathname.split("/")[2];

        const suppliedSecret =
          url.searchParams.get("secret");

        if (suppliedSecret !== SECRET) {
          return jsonError(
            "Invalid admin secret",
            403
          );
        }

        if (!CHANNELS[channelId]) {
          return jsonError(
            "Channel not found",
            404
          );
        }

        // Token valid for 1 hour
        const exp =
          Math.floor(Date.now() / 1000) + 3600;

        const signature =
          await sign(
            `${channelId}.${exp}`
          );

        const token =
          `${channelId}.${exp}.${signature}`;

        return new Response(
          JSON.stringify({
            success: true,

            channel: channelId,

            name:
              CHANNELS[channelId].name,

            expires:
              new Date(exp * 1000).toISOString(),

            url:
              `${url.origin}/live/${channelId}?token=${encodeURIComponent(token)}`
          }, null, 2),
          {
            headers: {
              "Content-Type":
                "application/json",
              ...corsHeaders()
            }
          }
        );
      }


      // ==================================================
      // LIVE ENDPOINT
      // ==================================================

      if (url.pathname.startsWith("/live/")) {

        const channelId =
          url.pathname.split("/")[2];

        const token =
          url.searchParams.get("token");

        if (!token) {
          return jsonError(
            "Token required",
            401
          );
        }


        // Verify token
        const valid =
          await verifyToken(
            token,
            channelId
          );

        if (!valid) {
          return jsonError(
            "Invalid or expired token",
            403
          );
        }


        const channel =
          CHANNELS[channelId];

        if (!channel) {
          return jsonError(
            "Channel not found",
            404
          );
        }


        // Fetch original M3U8
        const response =
          await fetch(
            channel.url,
            {
              method: "GET",

              headers: {
                "User-Agent":
                  "Mozilla/5.0",

                "Accept":
                  "*/*"
              },

              redirect: "follow"
            }
          );


        if (!response.ok) {

          return jsonError(
            "Origin returned HTTP " +
            response.status,
            502
          );

        }


        const content =
          await response.text();


        // Rewrite playlist
        const rewritten =
          rewritePlaylist(
            content,
            channel.url,
            token,
            url.origin
          );


        return new Response(
          rewritten,
          {
            status: 200,

            headers: {

              "Content-Type":
                "application/vnd.apple.mpegurl",

              "Cache-Control":
                "no-store, no-cache, must-revalidate",

              "Access-Control-Allow-Origin":
                "*",

              "Access-Control-Allow-Methods":
                "GET, OPTIONS",

              "Access-Control-Allow-Headers":
                "*"
            }
          }
        );

      }


      // ==================================================
      // ROOT
      // ==================================================

      if (url.pathname === "/") {

        return new Response(
`Secure M3U8 Gateway

Available channels:
${Object.entries(CHANNELS)
  .map(([id, c]) =>
    `${id} - ${c.name}`
  )
  .join("\n")}
`,
          {
            headers: {
              "Content-Type":
                "text/plain"
            }
          }
        );

      }


      return jsonError(
        "Not found",
        404
      );


    } catch (error) {

      return jsonError(
        "Worker error: " +
        error.message,
        500
      );

    }

  }
};


// ==================================================
// M3U8 REWRITE
// ==================================================

function rewritePlaylist(
  playlist,
  originURL,
  token,
  workerOrigin
) {

  const origin =
    new URL(originURL);

  const lines =
    playlist.split(/\r?\n/);


  return lines.map(line => {

    const trimmed =
      line.trim();


    if (!trimmed) {
      return line;
    }


    // Handle EXT-X-KEY URI
    if (trimmed.startsWith("#")) {

      if (line.includes('URI="')) {

        return line.replace(
          /URI="([^"]+)"/g,
          (match, value) => {

            try {

              const target =
                new URL(
                  value,
                  origin
                );

              return `URI="${makeProxyURL(
                target,
                token,
                workerOrigin
              )}"`;

            } catch {

              return match;

            }

          }
        );

      }

      return line;
    }


    // Segment / nested playlist
    try {

      const target =
        new URL(
          trimmed,
          origin
        );


      return makeProxyURL(
        target,
        token,
        workerOrigin
      );

    } catch {

      return line;

    }

  }).join("\n");

}


// ==================================================
// CREATE PROXY URL
// ==================================================

function makeProxyURL(
  target,
  token,
  workerOrigin
) {

  const proxy =
    new URL(
      workerOrigin + "/proxy"
    );


  proxy.searchParams.set(
    "url",
    target.href
  );


  proxy.searchParams.set(
    "token",
    token
  );


  return proxy.toString();

}


// ==================================================
// PROXY SEGMENTS
// ==================================================

async function handleProxy(
  request,
  url
) {

  const token =
    url.searchParams.get("token");

  const targetURL =
    url.searchParams.get("url");


  if (!token || !targetURL) {

    return jsonError(
      "Missing parameters",
      400
    );

  }


  let tokenData;

  try {

    tokenData =
      token.split(".");

    if (tokenData.length !== 3) {
      throw new Error();
    }

  } catch {

    return jsonError(
      "Invalid token",
      403
    );

  }


  const channelId =
    tokenData[0];


  if (
    !(await verifyToken(
      token,
      channelId
    ))
  ) {

    return jsonError(
      "Invalid or expired token",
      403
    );

  }


  // ------------------------------------------------
  // IMPORTANT:
  // Only allow proxying URLs belonging to the
  // configured channel origin.
  // This prevents the Worker from becoming an
  // unrestricted open proxy.
  // ------------------------------------------------

  const channel =
    CHANNELS[channelId];


  if (!channel) {

    return jsonError(
      "Channel not found",
      404
    );

  }


  const origin =
    new URL(channel.url);

  const target =
    new URL(targetURL);


  if (
    target.hostname !==
    origin.hostname
  ) {

    return jsonError(
      "Target host not allowed",
      403
    );

  }


  const response =
    await fetch(
      target.href,
      {
        method: "GET",

        headers: {
          "User-Agent":
            "Mozilla/5.0",

          "Accept":
            "*/*"
        },

        redirect: "follow"
      }
    );


  const headers =
    new Headers(response.headers);


  headers.set(
    "Access-Control-Allow-Origin",
    "*"
  );


  headers.set(
    "Cache-Control",
    "no-store"
  );


  return new Response(
    response.body,
    {
      status:
        response.status,

      headers
    }
  );

}


// ==================================================
// TOKEN VERIFY
// ==================================================

async function verifyToken(
  token,
  channelId
) {

  try {

    const parts =
      token.split(".");

    if (parts.length !== 3) {
      return false;
    }


    const id =
      parts[0];

    const exp =
      Number(parts[1]);

    const signature =
      parts[2];


    if (id !== channelId) {
      return false;
    }


    if (
      !Number.isFinite(exp) ||
      Math.floor(
        Date.now() / 1000
      ) > exp
    ) {

      return false;

    }


    const expected =
      await sign(
        `${id}.${exp}`
      );


    return timingSafeEqual(
      signature,
      expected
    );

  } catch {

    return false;

  }

}


// ==================================================
// HMAC SHA-256
// ==================================================

async function sign(message) {

  const encoder =
    new TextEncoder();


  const key =
    await crypto.subtle.importKey(
      "raw",
      encoder.encode(SECRET),

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
      encoder.encode(message)
    );


  return base64url(
    new Uint8Array(signature)
  );

}


// ==================================================
// BASE64URL
// ==================================================

function base64url(bytes) {

  let binary = "";

  for (
    const byte of bytes
  ) {

    binary +=
      String.fromCharCode(byte);

  }


  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

}


// ==================================================
// SAFE STRING COMPARE
// ==================================================

function timingSafeEqual(
  a,
  b
) {

  if (a.length !== b.length) {
    return false;
  }


  let result = 0;


  for (
    let i = 0;
    i < a.length;
    i++
  ) {

    result |=
      a.charCodeAt(i) ^
      b.charCodeAt(i);

  }


  return result === 0;

}


// ==================================================
// ERROR
// ==================================================

function jsonError(
  message,
  status
) {

  return new Response(
    JSON.stringify({
      success: false,
      error: message
    }, null, 2),

    {
      status,

      headers: {
        "Content-Type":
          "application/json",

        ...corsHeaders()
      }
    }
  );

}


// ==================================================
// CORS
// ==================================================

function corsHeaders() {

  return {

    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Methods":
      "GET, OPTIONS",

    "Access-Control-Allow-Headers":
      "*"

  };

          }
