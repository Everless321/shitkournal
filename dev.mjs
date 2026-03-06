import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadHandler(name) {
  const mod = await import(`./api/${name}.js`);
  return mod.default;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname.startsWith("/api/")) {
    const name = url.pathname.replace("/api/", "").replace(/\/$/, "");
    try {
      const handler = await loadHandler(name);
      const query = Object.fromEntries(url.searchParams);
      const fakeReq = { query, method: req.method, headers: req.headers };
      const fakeRes = {
        statusCode: 200,
        _headers: {},
        status(code) { this.statusCode = code; return this; },
        setHeader(k, v) { this._headers[k] = v; },
        json(data) {
          this._headers["Content-Type"] = "application/json";
          res.writeHead(this.statusCode, this._headers);
          res.end(JSON.stringify(data));
        },
        write(chunk) {
          if (!this._headersSent) {
            res.writeHead(this.statusCode, this._headers);
            this._headersSent = true;
          }
          res.write(chunk);
        },
        end() { res.end(); },
      };
      await handler(fakeReq, fakeRes);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  const filePath = path.join(__dirname, "public", "index.html");
  res.writeHead(200, { "Content-Type": "text/html" });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(3456, () => console.log("Dev server: http://localhost:3456"));
