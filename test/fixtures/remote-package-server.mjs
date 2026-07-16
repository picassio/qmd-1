import { writeFileSync, renameSync } from "node:fs";
import { createServer } from "node:http";

const [portFile, countsFile] = process.argv.slice(2);
if (!portFile || !countsFile) {
  throw new Error("usage: remote-package-server.mjs <port-file> <counts-file>");
}

const counts = { embeddings: 0, chat: 0 };
function persistCounts() {
  const temporary = `${countsFile}.tmp`;
  writeFileSync(temporary, JSON.stringify(counts));
  renameSync(temporary, countsFile);
}

const server = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    response.setHeader("content-type", "application/json");

    if (request.method === "POST" && request.url === "/embeddings") {
      counts.embeddings += 1;
      persistCounts();
      const payload = JSON.parse(body);
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
      response.end(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0] })),
        model: "ignored-by-agent-board-mode",
      }));
      return;
    }

    if (request.method === "POST" && request.url === "/chat/completions") {
      counts.chat += 1;
      persistCounts();
      response.end(JSON.stringify({
        choices: [{ message: { content: "unexpected expansion" } }],
      }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
});

persistCounts();
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  writeFileSync(portFile, String(address.port));
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
