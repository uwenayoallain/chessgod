/**
 * The page chess.uwe.rw shows while the tunnel is down.
 *
 * The site runs on one machine; when it is off, Cloudflare has no tunnel to send
 * traffic to and answers with its own error 1033 page. Custom error pages are
 * a paid-plan feature, so this Worker sits in front of the hostname instead:
 * every request passes straight through to the tunnel, and only a page
 * request (a browser asking for HTML) that comes back as a tunnel or gateway
 * error is answered with our own page — the board put away, a line of copy,
 * and a script that checks the health endpoint and reloads the moment the
 * server is back. API and asset requests keep their real status, so the app's
 * own outage screen still works when it is already open.
 *
 * Deployed by `make offline-page` (scripts/cloudflare/deploy_offline_page.py),
 * routed on chess.uwe.rw/*.
 */

const OFFLINE_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 530])

export default {
  async fetch(request) {
    const wantsPage =
      request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html')
    let response
    try {
      response = await fetch(request)
    } catch (error) {
      if (!wantsPage) throw error
      return offlinePage()
    }
    if (wantsPage && OFFLINE_STATUSES.has(response.status)) return offlinePage()
    return response
  },
}

function offlinePage() {
  return new Response(PAGE, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '30',
    },
  })
}

// Cburnett's king and pawn, as the app draws them: white body, dark outline.
const INK = '#312e2b'
const KING = `<g fill="#ffffff" stroke="${INK}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path fill="none" d="M 22.5,11.63 L 22.5,6 M 20,8 L 25,8"/><path d="M 22.5,25 C 22.5,25 27,17.5 25.5,14.5 C 25.5,14.5 24.5,12 22.5,12 C 20.5,12 19.5,14.5 19.5,14.5 C 18,17.5 22.5,25 22.5,25"/><path d="M 12.5,37 C 18,40.5 27,40.5 32.5,37 L 32.5,30 C 32.5,30 41.5,25.5 38.5,19.5 C 34.5,13 25,16 22.5,23.5 L 22.5,27 L 22.5,23.5 C 20,16 10.5,13 6.5,19.5 C 3.5,25.5 12.5,30 12.5,30 L 12.5,37"/><path fill="none" d="M 12.5,30 C 18,27 27,27 32.5,30 M 12.5,33.5 C 18,30.5 27,30.5 32.5,33.5 M 12.5,37 C 18,34 27,34 32.5,37"/></g>`
const PAWN = `<path fill="#ffffff" stroke="${INK}" stroke-width="1.5" stroke-linejoin="miter" d="m 22.5,9 c -2.21,0 -4,1.79 -4,4 0,0.89 0.29,1.71 0.78,2.38 C 17.33,16.5 16,18.59 16,21 c 0,2.03 0.94,3.84 2.41,5.03 C 15.41,27.09 11,31.58 11,39.5 H 34 C 34,31.58 29.59,27.09 26.59,26.03 28.06,24.84 29,23.03 29,21 29,18.59 27.67,16.5 25.72,15.38 26.21,14.71 26.5,13.89 26.5,13 c 0,-2.21 -1.79,-4 -4,-4 z"/>`

// A corner of the board at dusk: the king laid on its side for the night, a
// pawn still standing, the lamp a gold glow from the corner.
const ART = `<svg viewBox="0 0 320 200" width="320" height="200" role="img" aria-label="A chess king laid on its side on the board, a pawn standing beside it">
  <defs>
    <radialGradient id="lamp" cx="0.8" cy="0.1" r="0.9">
      <stop offset="0" stop-color="#f7d16b" stop-opacity="0.55"/>
      <stop offset="0.5" stop-color="#f7d16b" stop-opacity="0.08"/>
      <stop offset="1" stop-color="#f7d16b" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="dusk" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.45"/>
    </linearGradient>
    <clipPath id="board"><rect x="40" y="56" width="240" height="120" rx="6"/></clipPath>
  </defs>
  <g clip-path="url(#board)">
    <rect x="40" y="56" width="240" height="120" fill="#ebecd0"/>
    <g fill="#739552">
      <rect x="100" y="56" width="60" height="60"/><rect x="220" y="56" width="60" height="60"/>
      <rect x="40" y="116" width="60" height="60"/><rect x="160" y="116" width="60" height="60"/>
    </g>
    <rect x="40" y="56" width="240" height="120" fill="url(#dusk)"/>
  </g>
  <rect x="40" y="56" width="240" height="120" rx="6" fill="none" stroke="${INK}" stroke-opacity="0.6"/>
  <ellipse cx="200" cy="150" rx="48" ry="7" fill="#000" opacity="0.28"/>
  <ellipse cx="86" cy="150" rx="18" ry="5" fill="#000" opacity="0.28"/>
  <g transform="translate(62 96) scale(1.25)">${PAWN}</g>
  <g transform="translate(236 92) rotate(82) scale(1.45)">${KING}</g>
  <rect x="0" y="0" width="320" height="200" fill="url(#lamp)"/>
</svg>`

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ChessGod is off the board</title>
<meta name="robots" content="noindex">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center; padding: 24px 16px;
    background:
      radial-gradient(circle at 70% 20%, rgba(247, 209, 107, 0.10), transparent 45%),
      #1c1b19;
    color: #e9e5dc;
    font-family: Montserrat, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main {
    width: min(100%, 420px); text-align: center;
    padding: 28px 24px 24px; border-radius: 20px;
    border: 1px solid rgba(247, 209, 107, 0.35);
    background: linear-gradient(165deg, rgba(247, 209, 107, 0.10), transparent 48%), #262522;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55), inset 0 0 0 1px rgba(247, 209, 107, 0.14);
  }
  svg { display: block; width: 100%; height: auto; max-width: 320px; margin: 0 auto 14px; }
  .eyebrow {
    display: block; margin-bottom: 6px;
    color: #f7d16b; font-size: 11px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase;
  }
  h1 { margin: 0 0 10px; font-size: 26px; font-weight: 800; line-height: 1.1; letter-spacing: -0.01em; }
  p { margin: 0; color: #b7b2a7; font-size: 15px; line-height: 1.5; }
  .status { margin-top: 18px; font-size: 13px; color: #8d8880; font-variant-numeric: tabular-nums; }
  .status b { color: #f7d16b; font-weight: 700; }
  @media (prefers-reduced-motion: no-preference) {
    .dot { display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%;
      background: #f7d16b; animation: pulse 1.6s ease-in-out infinite; vertical-align: 1px; }
    @keyframes pulse { 50% { opacity: 0.25; } }
  }
</style>
</head>
<body>
<main>
  ${ART}
  <span class="eyebrow">Adjourned</span>
  <h1>ChessGod is off the board</h1>
  <p>The server is off right now. Your games and progress are safe, and the board is back the moment it is on.</p>
  <p class="status"><span class="dot"></span>Checking again in <b id="t">15</b>s</p>
</main>
<script>
  (function () {
    var wait = 15, left = wait, label = document.getElementById('t');
    function check() {
      fetch('/api/health', { cache: 'no-store' }).then(function (r) {
        if (r.ok) location.reload(); else again();
      }).catch(again);
    }
    function again() { left = wait = Math.min(60, wait + 5); }
    setInterval(function () {
      left -= 1; label.textContent = String(Math.max(0, left));
      if (left <= 0) { left = wait; check(); }
    }, 1000);
  })();
</script>
</body>
</html>`
