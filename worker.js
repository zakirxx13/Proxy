import channelsData from "./channels.json";

// ======================================================
// CONFIG
// ======================================================

const TOKEN_LIFETIME = 60 * 60 * 1000; // 1 hour

// তোমার Live TV frontend domain
const FRONTEND_ORIGIN = "https://boify.free.nf";

// Production-এ SECRET অবশ্যই Cloudflare Secret হিসেবে রাখবে.
// আপাতত test করার জন্য fallback দেওয়া হলো।
const SECRET = "CHANGE_THIS_TO_A_LONG_RANDOM_SECRET";

// ======================================================
// CHANNELS
// ======================================================

const CHANNELS = {};

for (const channel of channelsData.channels || []) {
  CHANNELS[channel.id] = channel;
}

// ======================================================
// CORS
// ======================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

// ======================================================
// RESPONSE HELPERS
// ======================================================

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

function textResponse(text, status = 200, extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "text/plain; charset=utf-8",
      ...extraHeaders
    }
  });
}

// ======================================================
// HMAC TOKEN
// ======================================================

function textToBytes(text) {
  return new TextEncoder().encode(text);
}

function bytesToBase64Url(bytes) {
  let binary = "";

  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunkSize)
    );
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(str) {
  str = str
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  while (str.length % 4) {
    str += "=";
  }

  const binary = atob(str);

  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

async function getKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    textToBytes(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );
}

async function createToken(channelId, expires, secret = SECRET) {
  const payload = `${channelId}:${expires}`;

  const key = await getKey(secret);

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textToBytes(payload)
  );

  return bytesToBase64Url(
    new Uint8Array(signature)
  );
}

// ======================================================
// TOKEN VALIDATION
// ======================================================

async function verifyToken(
  channelId,
  expires,
  token,
  secret = SECRET
) {
  if (!channelId || !expires || !token) {
    return false;
  }

  const expiration = Number(expires);

  if (!Number.isFinite(expiration)) {
    return false;
  }

  if (Date.now() > expiration) {
    return false;
  }

  const expectedToken = await createToken(
    channelId,
    expiration,
    secret
  );

  try {
    const a = base64UrlToBytes(expectedToken);
    const b = base64UrlToBytes(token);

    if (a.length !== b.length) {
      return false;
    }

    let result = 0;

    for (let i = 0; i < a.length; i++) {
      result |= a[i] ^ b[i];
    }

    return result === 0;

  } catch {
    return false;
  }
}

// ======================================================
// URL HELPERS
// ======================================================

function absoluteUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);

    return (
      u.protocol === "http:" ||
      u.protocol === "https:"
    );
  } catch {
    return false;
  }
}

// ======================================================
// M3U8 REWRITER
// ======================================================

function rewriteM3U8(
  content,
  sourceUrl,
  channelId,
  expires,
  token,
  workerOrigin
) {
  const lines = content.split(/\r?\n/);

  const output = [];

  for (const line of lines) {

    const trimmed = line.trim();

    // Empty line
    if (!trimmed) {
      output.push(line);
      continue;
    }

    // --------------------------------------------------
    // EXT-X-KEY
    // --------------------------------------------------

    if (
      trimmed.startsWith("#EXT-X-KEY:") ||
      trimmed.startsWith("#EXT-X-MAP:")
    ) {

      const rewritten = line.replace(
        /URI="([^"]+)"/i,
        (match, uri) => {

          const target = absoluteUrl(
            uri,
            sourceUrl
          );

          if (!target) {
            return match;
          }

          const proxyUrl =
            `${workerOrigin}/proxy` +
            `?url=${encodeURIComponent(target)}` +
            `&channel=${encodeURIComponent(channelId)}` +
            `&expires=${encodeURIComponent(expires)}` +
            `&token=${encodeURIComponent(token)}`;

          return `URI="${proxyUrl}"`;
        }
      );

      output.push(rewritten);
      continue;
    }

    // --------------------------------------------------
    // Other #EXT tags
    // --------------------------------------------------

    if (trimmed.startsWith("#")) {
      output.push(line);
      continue;
    }

    // --------------------------------------------------
    // Segment / Child Playlist
    // --------------------------------------------------

    const target = absoluteUrl(
      trimmed,
      sourceUrl
    );

    if (!target) {
      output.push(line);
      continue;
    }

    const proxyUrl =
      `${workerOrigin}/proxy` +
      `?url=${encodeURIComponent(target)}` +
      `&channel=${encodeURIComponent(channelId)}` +
      `&expires=${encodeURIComponent(expires)}` +
      `&token=${encodeURIComponent(token)}`;

    output.push(proxyUrl);
  }

  return output.join("\n");
}

// ======================================================
// GET CHANNEL
// ======================================================

function getChannel(channelId) {
  return CHANNELS[channelId] || null;
}

// ======================================================
// MAIN WORKER
// ======================================================

export default {
  async fetch(request, env) {

    const url = new URL(request.url);

    // --------------------------------------------------
    // OPTIONS / CORS
    // --------------------------------------------------

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    // Only GET / HEAD
    if (
      request.method !== "GET" &&
      request.method !== "HEAD"
    ) {
      return textResponse(
        "Method Not Allowed",
        405,
        {
          "Allow": "GET, HEAD, OPTIONS"
        }
      );
    }

    // --------------------------------------------------
    // SECRET
    // --------------------------------------------------

    // Prefer Cloudflare Secret named SECRET.
    const secret =
      env?.SECRET ||
      SECRET;

    // ==================================================
    // HOME
    // ==================================================

    if (url.pathname === "/") {

      return jsonResponse({
        status: "online",
        service: "Secure M3U8 Gateway",
        channels: Object.keys(CHANNELS).length,
        endpoints: {
          channels: "/channels",
          apiChannels: "/api/channels",
          playlist: "/playlist.m3u"
        }
      });
    }

    // ==================================================
    // CHANNEL LIST
    // ==================================================

    if (
      url.pathname === "/channels" ||
      url.pathname === "/api/channels"
    ) {

      const list = Object.values(CHANNELS).map(
        channel => ({
          id: channel.id,
          name: channel.name || "",
          group: channel.group || "",
          category: channel.category || channel.group || "",
          logo: channel.logo || ""
        })
      );

      return jsonResponse(list, 200, {
        "Cache-Control": "no-store"
      });
    }

    // ==================================================
    // M3U PLAYLIST
    // ==================================================

    if (url.pathname === "/playlist.m3u") {

      const lines = [
        "#EXTM3U"
      ];

      for (const channel of Object.values(CHANNELS)) {

        const expires = Date.now() + TOKEN_LIFETIME;

        const token = await createToken(
          channel.id,
          expires,
          secret
        );

        const streamUrl =
          `${url.origin}/${channel.id}.m3u8` +
          `?expires=${expires}` +
          `&token=${encodeURIComponent(token)}`;

        const logo = channel.logo || "";

        const group =
          channel.group ||
          channel.category ||
          "Live TV";

        lines.push(
          `#EXTINF:-1 tvg-id="${channel.id}" tvg-name="${channel.name}" tvg-logo="${logo}" group-title="${group}",${channel.name}`
        );

        lines.push(streamUrl);
      }

      return new Response(
        lines.join("\n") + "\n",
        {
          status: 200,
          headers: {
            ...corsHeaders(),
            "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
            "Cache-Control": "no-store"
          }
        }
      );
    }

    // ==================================================
    // TOKEN API
    // /token/btv.m3u8
    // ==================================================

    if (url.pathname.startsWith("/token/")) {

      const channelId =
        url.pathname
          .replace("/token/", "")
          .replace(/\.m3u8$/, "");

      const channel =
        getChannel(channelId);

      if (!channel) {
        return jsonResponse(
          {
            error: "Channel not found",
            channel: channelId
          },
          404
        );
      }

      const expires =
        Date.now() + TOKEN_LIFETIME;

      const token =
        await createToken(
          channelId,
          expires,
          secret
        );

      const streamUrl =
        `${url.origin}/${channelId}.m3u8` +
        `?expires=${expires}` +
        `&token=${encodeURIComponent(token)}`;

      return jsonResponse(
        {
          channel: channelId,
          name: channel.name || "",
          expires,
          token,
          url: streamUrl
        },
        200,
        {
          "Cache-Control": "no-store"
        }
      );
    }

    // ==================================================
    // PROTECTED CHANNEL M3U8
    // /btv.m3u8?expires=...&token=...
    // ==================================================

    if (
      url.pathname.endsWith(".m3u8") &&
      !url.pathname.startsWith("/token/")
    ) {

      const channelId =
        url.pathname
          .replace(/^\//, "")
          .replace(/\.m3u8$/, "");

      const channel =
        getChannel(channelId);

      if (!channel) {
        return textResponse(
          "Channel not found",
          404
        );
      }

      const expires =
        url.searchParams.get("expires");

      const token =
        url.searchParams.get("token");

      const valid =
        await verifyToken(
          channelId,
          expires,
          token,
          secret
        );

      if (!valid) {
        return textResponse(
          "Invalid or expired token",
          403
        );
      }

      if (!channel.url) {
        return textResponse(
          "Channel source unavailable",
          502
        );
      }

      try {

        const originResponse =
          await fetch(channel.url, {
            method: "GET",
            headers: {
              "User-Agent":
                "Mozilla/5.0 SecureStreamGateway",
              "Accept":
                "application/vnd.apple.mpegurl,application/x-mpegURL,*/*"
            }
          });

        if (!originResponse.ok) {
          return textResponse(
            `Origin returned ${originResponse.status}`,
            502
          );
        }

        const content =
          await originResponse.text();

        const rewritten =
          rewriteM3U8(
            content,
            channel.url,
            channelId,
            expires,
            token,
            url.origin
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
                "no-store",
              "Access-Control-Expose-Headers":
                "Content-Type"
            }
          }
        );

      } catch (error) {

        return jsonResponse(
          {
            error: "Failed to fetch origin",
            message: error?.message || "Unknown error"
          },
          502
        );
      }
    }

    // ==================================================
    // PROXY SEGMENTS / CHILD PLAYLIST / KEY
    // /proxy?url=...&channel=...&expires=...&token=...
    // ==================================================

    if (url.pathname === "/proxy") {

      const target =
        url.searchParams.get("url");

      const channelId =
        url.searchParams.get("channel");

      const expires =
        url.searchParams.get("expires");

      const token =
        url.searchParams.get("token");

      // ----------------------------------------------
      // Required parameters
      // ----------------------------------------------

      if (
        !target ||
        !channelId ||
        !expires ||
        !token
      ) {
        return textResponse(
          "Missing proxy parameters",
          400
        );
      }

      // ----------------------------------------------
      // Channel exists?
      // ----------------------------------------------

      const channel =
        getChannel(channelId);

      if (!channel) {
        return textResponse(
          "Channel not found",
          404
        );
      }

      // ----------------------------------------------
      // Token
      // ----------------------------------------------

      const valid =
        await verifyToken(
          channelId,
          expires,
          token,
          secret
        );

      if (!valid) {
        return textResponse(
          "Invalid or expired token",
          403
        );
      }

      // ----------------------------------------------
      // Validate target URL
      // ----------------------------------------------

      if (!isHttpUrl(target)) {
        return textResponse(
          "Invalid target URL",
          400
        );
      }

      let targetUrl;

      try {
        targetUrl = new URL(target);
      } catch {
        return textResponse(
          "Invalid target URL",
          400
        );
      }

      // ----------------------------------------------
      // Origin hostname allowlist
      // ----------------------------------------------

      let originUrl;

      try {
        originUrl =
          new URL(channel.url);
      } catch {
        return textResponse(
          "Invalid channel origin",
          500
        );
      }

      if (
        targetUrl.hostname !==
        originUrl.hostname
      ) {
        return textResponse(
          "Target host not allowed",
          403
        );
      }

      // ----------------------------------------------
      // Fetch target
      // ----------------------------------------------

      try {

        const response =
          await fetch(
            targetUrl.toString(),
            {
              method: "GET",
              headers: {
                "User-Agent":
                  "Mozilla/5.0 SecureStreamGateway",
                "Accept":
                  "*/*"
              }
            }
          );

        if (!response.ok) {
          return textResponse(
            `Origin returned ${response.status}`,
            502
          );
        }

        // --------------------------------------------
        // Determine content type
        // --------------------------------------------

        const contentType =
          response.headers.get(
            "content-type"
          ) ||
          "application/octet-stream";

        // --------------------------------------------
        // Child M3U8
        // --------------------------------------------

        if (
          targetUrl.pathname
            .toLowerCase()
            .endsWith(".m3u8") ||
          contentType
            .toLowerCase()
            .includes("mpegurl")
        ) {

          const content =
            await response.text();

          const rewritten =
            rewriteM3U8(
              content,
              targetUrl.toString(),
              channelId,
              expires,
              token,
              url.origin
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

        // --------------------------------------------
        // Segment / key / other binary
        // --------------------------------------------

        return new Response(
          response.body,
          {
            status: response.status,
            headers: {
              ...corsHeaders(),
              "Content-Type": contentType,
              "Cache-Control":
                "no-store"
            }
          }
        );

      } catch (error) {

        return jsonResponse(
          {
            error: "Proxy request failed",
            message:
              error?.message ||
              "Unknown error"
          },
          502
        );
      }
    }

    // ==================================================
    // 404
    // ==================================================

    return jsonResponse(
      {
        error: "Not Found",
        path: url.pathname
      },
      404
    );
  }
};
