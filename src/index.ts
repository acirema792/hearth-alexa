import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { isInitializeRequest } from "@modelcontextprotocol/server";
import { CareEngine } from "./care.js";
import { Clock } from "./clock.js";
import { Notifier, SandboxPharmacy } from "./services.js";
import { Store } from "./store.js";
import { buildServer } from "./tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA = process.env.HEARTH_DATA ?? join(here, "..", "data", "hearth.json");
const DEMO = process.env.HEARTH_DEMO !== "0";
const ROUNDS_SEC = Number(process.env.HEARTH_ROUNDS_INTERVAL_SEC ?? 60);
const EXTRA_ORIGINS = (process.env.HEARTH_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const clock = new Clock("America/Phoenix");
const store = new Store(DATA, () => clock.now());
const care = new CareEngine(store, clock, new Notifier(), new SandboxPharmacy());

// ------------------------------------------------------------------ helpers

function originAllowed(origin: string | undefined): boolean {
  if (!origin || origin === "null") return true; // non-browser clients, sandboxed iframes
  if (EXTRA_ORIGINS.includes("*") || EXTRA_ORIGINS.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return ["localhost", "127.0.0.1", "[::1]"].includes(hostname) || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id, mcp-protocol-version, last-event-id, authorization");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
  }
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// ------------------------------------------------------------------ MCP over Streamable HTTP (stateful sessions)

const sessions = new Map<string, NodeStreamableHTTPServerTransport>();

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (req.method === "POST") {
    const body = await readJson(req);
    let transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!transport) {
      if (sessionId || !isInitializeRequest(body)) {
        return json(res, sessionId ? 404 : 400, { jsonrpc: "2.0", error: { code: -32000, message: sessionId ? "Session not found" : "No valid session; send initialize first" }, id: null });
      }
      transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport!);
          log(`session ${id.slice(0, 8)} opened by ${body?.params?.clientInfo?.name ?? "client"} (protocol ${body?.params?.protocolVersion})`);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      transport.onclose = () => transport!.sessionId && sessions.delete(transport!.sessionId);
      await buildServer(care).connect(transport);
    }
    return transport.handleRequest(req, res, body);
  }
  if (req.method === "GET" || req.method === "DELETE") {
    const transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!transport) return json(res, 404, { jsonrpc: "2.0", error: { code: -32000, message: "Session not found" }, id: null });
    return transport.handleRequest(req, res);
  }
  res.writeHead(405).end();
}

// ------------------------------------------------------------------ companion app (Daniel's phone) + live events

const sseClients = new Set<ServerResponse>();
store.on("change", (evt) => {
  for (const c of sseClients) c.write(`event: change\ndata: ${JSON.stringify(evt)}\n\n`);
});

function companionState() {
  return { weekly: care.weekly(), today: care.todayBoard(), notifications: care.state.notifications.filter((n) => n.to === care.primary.id).slice(-20).reverse(), clock: { now: clock.now().toISOString(), adjusted: clock.isAdjusted() } };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string) {
  if (path === "/api/state" && req.method === "GET") return json(res, 200, companionState());
  if (path === "/events" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`event: hello\ndata: {}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
    return;
  }
  if (path === "/api/message" && req.method === "POST") {
    const b = await readJson(req);
    return json(res, 200, await care.sendMessage({ from: b.from ?? care.primary.id, to: b.to ?? care.recipient.id, text: String(b.text ?? "") }));
  }
  if (path === "/api/confirm-refill" && req.method === "POST") {
    const b = await readJson(req);
    return json(res, 200, await care.confirmRefill({ token: String(b.token), confirmedBy: b.confirmedBy ?? care.primary.id }));
  }
  // Demo controls: move the household clock so a 60-minute escalation fits in a video.
  if (DEMO && path === "/demo/clock" && req.method === "POST") {
    const b = (await readJson(req)) ?? {};
    if (b.reset) clock.reset();
    if (b.set) clock.set(String(b.set));
    if (b.advanceMinutes) clock.advance(Number(b.advanceMinutes));
    const rounds = b.runRounds === false ? null : await care.runCareRounds();
    store.mutate("clock", () => undefined);
    return json(res, 200, { now: clock.now().toISOString(), local: care.todayBoard().nowLabel, rounds });
  }
  if (DEMO && path === "/demo/reset" && req.method === "POST") {
    clock.reset();
    const b = (await readJson(req)) ?? {};
    if (b.set) clock.set(String(b.set));
    store.reset(clock.now());
    return json(res, 200, { ok: true, now: clock.now().toISOString(), local: care.todayBoard().nowLabel });
  }
  return json(res, 404, { error: "not found" });
}

// ------------------------------------------------------------------ http server

const companionHtml = () => readFileSync(join(here, "..", "companion", "index.html"), "utf8");

const http = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (!originAllowed(req.headers.origin)) return json(res, 403, { error: "Origin not allowed" });
    cors(req, res);
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (url.pathname === "/mcp") return await handleMcp(req, res);
    if (url.pathname === "/healthz") return json(res, 200, { ok: true, name: "hearth", protocol: "2025-11-25", transport: "streamable-http", sessions: sessions.size });
    if (url.pathname === "/" || url.pathname === "/companion") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(companionHtml());
    }
    return await handleApi(req, res, url.pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: String((err as Error).message ?? err) });
  }
});

function log(msg: string) {
  console.log(`[hearth ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

http.listen(PORT, HOST, () => {
  log(`MCP endpoint  http://${HOST}:${PORT}/mcp  (Streamable HTTP, MCP 2025-11-25, MCP Apps)`);
  log(`Family app    http://${HOST}:${PORT}/companion`);
  if (DEMO) log(`Demo controls enabled (POST /demo/clock, /demo/reset). Set HEARTH_DEMO=0 to disable.`);
});

// The care loop runs on its own, like an Alexa+ routine would: no one has to ask.
if (ROUNDS_SEC > 0) {
  setInterval(() => {
    care.runCareRounds().then((r) => r.actions.length && log(`care rounds → ${r.summary}`)).catch((e) => console.error(e));
  }, ROUNDS_SEC * 1000).unref();
}
