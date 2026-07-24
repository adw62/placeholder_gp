// Spawns `python3 -m http.server` for whatever directory it's given
// (directory listings are load-bearing: levels/, crowd kits, and texture
// folders are discovered by parsing them — see game/src/levels.js). Picks a
// free port, waits for the server to answer, returns { port, url, stop }.
import { spawn } from "node:child_process";
import net from "node:net";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export async function serve(root) {
  const port = await freePort();
  const child = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], {
    cwd: root,
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url + "/", { signal: AbortSignal.timeout(1000) });
      if (res.ok) return { port, url, stop: () => child.kill() };
    } catch {
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  child.kill();
  throw new Error(`dev server did not come up on ${url}`);
}
