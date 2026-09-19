export async function onRequest() {
  return new Response(
    JSON.stringify({
      success: true,
      name: "M3U8 Proxy API",
      version: "1.0.0",
      status: "online",
      endpoint: "/api/proxy?url=ENCODED_M3U8_URL"
    }, null, 2),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Access-Control-Allow-Origin": "*"
      }
    }
  );
}
