/**
 * M3U8 Proxy API
 * Public API for streaming M3U8 with header bypass
 * Endpoint: /api/proxy?url=ENCODED_M3U8_URL
 */

// CORS Headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

// Allowed referers (optional - for your own domains)
const ALLOWED_DOMAINS = [
  'localhost',
  '127.0.0.1',
  // Add your domains here
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      // API Routes
      if (path === '/api/proxy') {
        return await handleProxy(request, url);
      }
      
      if (path === '/api/play') {
        return await handlePlayPage(request, url);
      }
      
      if (path === '/api/embed') {
        return await handleEmbed(request, url);
      }
      
      if (path === '/api/info') {
        return await handleInfo();
      }
      
      // Default: Serve demo page
      return await serveDemoPage();

    } catch (error) {
      return jsonResponse({ 
        success: false, 
        error: error.message 
      }, 500);
    }
  }
};

// Main Proxy Handler
async function handleProxy(request, url) {
  const targetUrl = url.searchParams.get('url');
  const customReferer = url.searchParams.get('referer');
  const customOrigin = url.searchParams.get('origin');
  
  if (!targetUrl) {
    return jsonResponse({
      success: false,
      error: 'Missing url parameter',
      usage: '/api/proxy?url=ENCODED_M3U8_URL'
    }, 400);
  }

  try {
    const decodedUrl = decodeURIComponent(targetUrl);
    
    // Build headers
    const headers = new Headers();
    headers.set('User-Agent', request.headers.get('User-Agent') || 
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    headers.set('Accept', '*/*');
    headers.set('Accept-Language', 'en-US,en;q=0.9');
    
    // Use custom or default referer/origin
    const referer = customReferer || 'https://example.com/';
    const origin = customOrigin || 'https://example.com';
    
    headers.set('Referer', referer);
    headers.set('Origin', origin);
    
    // Forward authorization if present
    const auth = request.headers.get('Authorization');
    if (auth) headers.set('Authorization', auth);

    // Fetch target
    const response = await fetch(decodedUrl, {
      method: 'GET',
      headers: headers,
      redirect: 'follow',
    });

    // Build response with CORS
    const responseHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => {
      responseHeaders.set(key, value);
    });

    // Ensure content-type is preserved
    const contentType = response.headers.get('content-type');
    if (contentType) {
      responseHeaders.set('Content-Type', contentType);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });

  } catch (error) {
    return jsonResponse({
      success: false,
      error: 'Proxy failed: ' + error.message
    }, 500);
  }
}

// Simple Player Page
async function handlePlayPage(request, url) {
  const targetUrl = url.searchParams.get('url');
  const title = url.searchParams.get('title') || 'Video Player';
  
  if (!targetUrl) {
    return new Response('URL parameter required', { status: 400 });
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"><\/script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      background: #000; 
      display: flex; 
      justify-content: center; 
      align-items: center; 
      min-height: 100vh;
      font-family: Arial, sans-serif;
    }
    .container { width: 100%; max-width: 900px; padding: 20px; }
    h2 { color: #fff; margin-bottom: 15px; text-align: center; }
    video { 
      width: 100%; 
      border-radius: 10px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
    }
    .error { 
      color: #ff4444; 
      text-align: center; 
      padding: 20px;
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <h2>${escapeHtml(title)}</h2>
    <video id="video" controls></video>
    <div id="error" class="error"></div>
  </div>
  <script>
    const video = document.getElementById('video');
    const proxyUrl = '/api/proxy?url=${targetUrl}';
    
    if (Hls.isSupported()) {
      const hls = new Hls({
        xhrSetup: function(xhr, url) {
          if (!url.includes('${url.origin}')) {
            xhr.open('GET', '${url.origin}/api/proxy?url=' + encodeURIComponent(url), true);
          }
        }
      });
      hls.loadSource(proxyUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play());
      hls.on(Hls.Events.ERROR, (e, data) => {
        document.getElementById('error').textContent = 'Error: ' + data.type;
        document.getElementById('error').style.display = 'block';
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = proxyUrl;
      video.play();
    } else {
      document.getElementById('error').textContent = 'HLS not supported';
      document.getElementById('error').style.display = 'block';
    }
  <\/script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html' }
  });
}

// Embed Script for external sites
async function handleEmbed(request, url) {
  const targetUrl = url.searchParams.get('url');
  
  const js = `
(function() {
  const containerId = 'm3u8-player-' + Math.random().toString(36).substr(2, 9);
  const proxyUrl = '${url.origin}/api/proxy?url=${encodeURIComponent(targetUrl || '')}';
  
  document.currentScript.insertAdjacentHTML('afterend', 
    '<div id="' + containerId + '" style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;">' +
    '<video id="video-' + containerId + '" controls style="position:absolute;top:0;left:0;width:100%;height:100%;"></video>' +
    '</div>'
  );
  
  const video = document.getElementById('video-' + containerId);
  
  if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    const hls = new Hls({
      xhrSetup: function(xhr, url) {
        if (!url.includes('${url.origin}')) {
          xhr.open('GET', '${url.origin}/api/proxy?url=' + encodeURIComponent(url), true);
        }
      }
    });
    hls.loadSource('${targetUrl ? '${url.origin}/api/proxy?url=' + encodeURIComponent(targetUrl) : "' + proxyUrl + '"}');
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, function() { video.play(); });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = '${targetUrl ? '${url.origin}/api/proxy?url=' + encodeURIComponent(targetUrl) : "' + proxyUrl + '"}';
    video.play();
  }
})();
`;
  
  return new Response(js, {
    headers: { 
      'Content-Type': 'application/javascript',
      ...corsHeaders
    }
  });
}

// API Info
async function handleInfo() {
  return jsonResponse({
    success: true,
    name: 'M3U8 Proxy API',
    version: '1.0.0',
    endpoints: {
      proxy: '/api/proxy?url=ENCODED_URL',
      play: '/api/play?url=ENCODED_URL&title=Video+Title',
      embed: '/api/embed?url=ENCODED_URL',
      info: '/api/info'
    },
    usage: {
      proxy: 'Returns proxied M3U8/stream with bypassed headers',
      play: 'Returns HTML player page',
      embed: 'Returns JavaScript embed code'
    }
  });
}

// Demo Page
async function serveDemoPage() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>M3U8 Proxy API</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 40px 20px;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    h1 {
      color: #fff;
      text-align: center;
      margin-bottom: 10px;
      font-size: 2.5em;
    }
    .subtitle {
      text-align: center;
      color: rgba(255,255,255,0.8);
      margin-bottom: 40px;
    }
    .card {
      background: #fff;
      border-radius: 15px;
      padding: 30px;
      margin-bottom: 20px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
    }
    h2 {
      color: #333;
      margin-bottom: 15px;
      font-size: 1.3em;
    }
    .endpoint {
      background: #f5f5f5;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 10px;
      font-family: monospace;
      font-size: 14px;
    }
    .method {
      display: inline-block;
      background: #667eea;
      color: #fff;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 12px;
      margin-right: 10px;
    }
    input[type="text"] {
      width: 100%;
      padding: 15px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 10px;
    }
    input:focus {
      outline: none;
      border-color: #667eea;
    }
    button {
      background: #667eea;
      color: #fff;
      border: none;
      padding: 15px 30px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 16px;
      font-weight: bold;
    }
    button:hover {
      background: #5a6fd6;
    }
    .code-block {
      background: #1a1a2e;
      color: #00ff88;
      padding: 20px;
      border-radius: 8px;
      overflow-x: auto;
      font-family: monospace;
      font-size: 13px;
      margin-top: 15px;
    }
    .footer {
      text-align: center;
      color: rgba(255,255,255,0.6);
      margin-top: 40px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎬 M3U8 Proxy API</h1>
    <p class="subtitle">Free M3U8 streaming proxy with header bypass</p>
    
    <div class="card">
      <h2>Try It</h2>
      <input type="text" id="m3u8Url" placeholder="Paste M3U8 URL here...">
      <button onclick="play()">▶ Play Video</button>
      <div id="result" style="margin-top:20px;"></div>
    </div>
    
    <div class="card">
      <h2>API Endpoints</h2>
      <div class="endpoint">
        <span class="method">GET</span>
        <strong>/api/proxy?url=ENCODED_URL</strong>
        <br><small>Returns proxied stream with bypassed headers</small>
      </div>
      <div class="endpoint">
        <span class="method">GET</span>
        <strong>/api/play?url=ENCODED_URL</strong>
        <br><small>Returns HTML player page</small>
      </div>
      <div class="endpoint">
        <span class="method">GET</span>
        <strong>/api/embed?url=ENCODED_URL</strong>
        <br><small>Returns JavaScript embed code</small>
      </div>
    </div>
    
    <div class="card">
      <h2>Usage Example</h2>
      <div class="code-block">
// For your website - Simple iframe embed:
&lt;iframe src="https://your-worker.workers.dev/api/play?url=ENCODED_M3U8_URL" 
        width="100%" height="400" frameborder="0"&gt;&lt;/iframe&gt;

// Or use the proxy directly in your player:
const proxyUrl = 'https://your-worker.workers.dev/api/proxy?url=' + 
                 encodeURIComponent(m3u8Url);
      </div>
    </div>
    
    <div class="footer">
      <p>Powered by Cloudflare Workers • Free for authorized use</p>
    </div>
  </div>
  
  <script>
    function play() {
      const url = document.getElementById('m3u8Url').value;
      if (!url) return alert('Please enter M3U8 URL');
      const encoded = encodeURIComponent(url);
      const iframe = '<iframe src="/api/play?url=' + encoded + '" width="100%" height="400" frameborder="0" allowfullscreen style="border-radius:10px;"></iframe>';
      document.getElementById('result').innerHTML = iframe;
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html' }
  });
}

// Helper: JSON Response
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}

// Helper: Escape HTML
function escapeHtml(text) {
  const div = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => div[m]);
        }
