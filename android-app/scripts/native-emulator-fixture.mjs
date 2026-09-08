import { createServer } from "node:http";

// A tiny ES5 fixture for old system WebViews. No backend calls, credentials or game data.
const html = `<!doctype html><meta charset="utf-8"><title>Native emulator diagnostics</title>
<h1>Native emulator diagnostics</h1><pre id="status">Ready</pre>
<script>
window.addEventListener('msh-android-oauth-status', function (event) {
  document.getElementById('status').textContent = JSON.stringify(event.detail);
});
</script>`;
createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(html);
}).listen(19310, "127.0.0.1", () => console.log("Native emulator fixture listening on 19310"));
