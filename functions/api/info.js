export async function onRequest(context) {
  return new Response(
    JSON.stringify(
      {
        success: true,
        name: "M3U8 Proxy API",
        version: "1.0.0",
        status: "online",
        message: "M3U8 Proxy API is running",
        endpoint: "/api/proxy?url=YOUR_M3U8_URL"
      },
      null,
      2
    ),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Cache-Control": "no-store"
      }
    }
  );
}
