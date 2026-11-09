// Serves the built extension (dist/) on localhost with stub.js injected into every page,
// so the views run in a normal browser tab against fake data. See dev/harness/README.md.
//
//   npm run harness            # build, then serve on http://127.0.0.1:8765
//   PORT=9000 npm run harness
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../dist");
const stubPath = resolve(import.meta.dirname, "stub.js");
const port = Number(process.env.PORT) || 8765;
const STUB_URL = "/__harness/stub.js";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  // no-store: a cached stub from an earlier build silently disables the fakes.
  const send = (status, type, body) => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
  };

  if (pathname === "/" ) {
    res.writeHead(302, { Location: "/html/index.html?type=web&property=sc-domain%3Aexample.com" });
    return res.end();
  }
  if (pathname === STUB_URL) {
    return send(200, types[".js"], await readFile(stubPath));
  }

  const file = normalize(join(root, decodeURIComponent(pathname)));
  if (!file.startsWith(root)) return send(403, "text/plain", "forbidden");

  try {
    let body = await readFile(file);
    const ext = extname(file);
    if (ext === ".html") {
      body = body
        .toString()
        .replace("<head>", `<head>\n<script src="${STUB_URL}"></script>`);
    }
    send(200, types[ext] ?? "application/octet-stream", body);
  } catch {
    send(404, "text/plain", "not found — did you run `npm run build`?");
  }
});

server.listen(port, "127.0.0.1", () => {
  const base = `http://127.0.0.1:${port}`;
  console.log(`Harness serving dist/ with fake chrome.* + Search Console API`);
  console.log(`  property by hour  ${base}/html/index.html?type=web&property=sc-domain%3Aexample.com`);
  console.log(`  property by day   ${base}/html/days.html?type=web&property=sc-domain%3Aexample.com`);
  console.log(`  pages by hour     ${base}/html/hourly.html?type=web&property=sc-domain%3Aexample.com`);
  console.log(`  options           ${base}/html/options.html`);
  console.log(`  signed-out start  append &__noauth=1 to any view URL`);
});
