// A local stand-in for the OpenAI Responses API that replays the Exodus 33:3 golden responses.
// Demo only: COMMENTARY_DEMO=1 COMMENTARY_OPENAI_BASE_URL=http://127.0.0.1:8899/v1 points the app at it.
import http from "node:http";
import { sse, fakeModel } from "../tests/fixtures/fake-model.ts";

http
  .createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      if (req.method === "GET" && req.url?.startsWith("/v1/models/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: req.url.split("/").at(-1) }));
        return;
      }
      const request = JSON.parse(body);
      const r = sse({ json: fakeModel(request), model: request.model });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(await r.text());
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: String(e) } }));
    }
  })
  .listen(8899, "127.0.0.1", () => console.log("fake OpenAI on http://127.0.0.1:8899"));
