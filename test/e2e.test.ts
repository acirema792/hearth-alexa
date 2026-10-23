/**
 * End-to-end: start the real server, connect a real MCP client over Streamable HTTP,
 * and walk through Rosa's morning plus a missed-dose escalation and a refill purchase.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess;
let client: Client;

async function post(path: string, body: unknown) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as any;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-"));
  proc = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), HEARTH_DATA: join(dir, "h.json"), HEARTH_ROUNDS_INTERVAL_SEC: "0" },
    stdio: "pipe",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  await post("/demo/reset", { set: "07:55" });
  client = new Client(
    { name: "hearth-e2e", version: "1.0.0" },
    { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } as any },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
});

after(async () => {
  await client?.close();
  proc?.kill();
});

test("negotiates MCP 2025-11-25 over Streamable HTTP", async () => {
  const transport = (client as any)._transport as StreamableHTTPClientTransport;
  assert.ok(transport.sessionId, "server issued a session id");
  assert.equal((transport as any)._protocolVersion ?? "2025-11-25", "2025-11-25");
  assert.match(client.getInstructions() ?? "", /dosing advice/);
});

test("tools declare MCP Apps UI resources and visibility", async () => {
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal((byName.show_today._meta as any).ui.resourceUri, "ui://hearth/today.html");
  assert.deepEqual((byName.refresh_today._meta as any).ui.visibility, ["app"]);
  const { resources } = await client.listResources();
  const today = resources.find((r) => r.uri === "ui://hearth/today.html")!;
  assert.equal(today.mimeType, "text/html;profile=mcp-app");
  const read = await client.readResource({ uri: "ui://hearth/today.html" });
  assert.match((read.contents[0] as any).text, /<!doctype html>/i);
});

test("morning: board, log morning pills, double-dose guard", async () => {
  const board = await call("show_today");
  assert.equal(board.structuredContent.board.doses.length, 4);
  await post("/demo/clock", { set: "08:10", runRounds: false });
  const logged = await call("log_medication", { medication: "morning pills" });
  assert.equal(logged.structuredContent.logged.length, 2, "lisinopril + metformin AM");
  const again = await call("log_medication", { medication: "metformin" });
  assert.match(again.content[0].text, /already logged/i);
  assert.match(again.content[0].text, /don't take another/i);
});

test("check-in with a lot of pain flags the primary caregiver", async () => {
  const r = await call("record_check_in", { mood: "okay", sleep: "poorly", pain: "a lot", note: "my knee" });
  assert.deepEqual(r.structuredContent.familyNotified, ["Daniel"]);
});

test("care rounds: refill forecast, missed dose ladder, idempotent, resolves", async () => {
  const first = await call("run_care_rounds");
  assert.ok(first.structuredContent.actions.some((a: any) => a.kind === "refill_quote"), "metformin low → quote");
  // Evening metformin at 19:00 is missed; move to 20:05 (65 min late).
  await post("/demo/clock", { set: "20:05", runRounds: false });
  const rounds = await call("run_care_rounds");
  const kinds = rounds.structuredContent.actions.map((a: any) => a.kind);
  assert.ok(kinds.includes("reminder") && kinds.includes("notify_primary"), kinds.join(","));
  const again = await call("run_care_rounds");
  assert.ok(!again.structuredContent.actions.some((a: any) => a.kind === "notify_primary"), "no duplicate texts");
  const took = await call("log_medication", { medication: "metformin" });
  assert.deepEqual(took.structuredContent.familyUpdated, ["Daniel"], "close the loop with Daniel");
});

test("refill purchase requires a quote token and confirms once", async () => {
  const q = await call("quote_refill", { medication: "blood sugar" });
  assert.equal(q.structuredContent.requiresConfirmation, true);
  const bad = await call("confirm_refill", { token: "nope" });
  assert.equal(bad.isError, true);
  const ok = await call("confirm_refill", { token: q.structuredContent.quote.token, confirmedBy: "Daniel" });
  assert.equal(ok.structuredContent.confirmed, true);
  const twice = await call("confirm_refill", { token: q.structuredContent.quote.token });
  assert.equal(twice.isError, true);
});

test("state persists across sessions (a second device sees the same record)", async () => {
  const other = new Client({ name: "daniels-phone", version: "1.0.0" });
  await other.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  const dash = (await other.callTool({ name: "show_family_dashboard", arguments: {} })) as any;
  assert.ok(dash.structuredContent.orders.length >= 1);
  assert.ok(dash.structuredContent.alerts.length >= 2);
  const summary = (await other.callTool({ name: "get_care_summary", arguments: {} })) as any;
  assert.match(summary.content[0].text, /% of doses taken/);
  await other.close();
});

test("proactive: subscribed devices get resources/updated and can read the announcement", async () => {
  const echo = new Client({ name: "rosas-echo", version: "1.0.0" });
  await echo.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  const got: string[] = [];
  echo.setNotificationHandler("notifications/resources/updated" as any, async (n: any) => {
    got.push(n.params.uri);
  });
  await echo.subscribeResource({ uri: "hearth://announcements" });
  await new Promise((r) => setTimeout(r, 300)); // let the standalone SSE stream open
  await post("/api/message", { from: "daniel", to: "rosa", text: "Love you Mom" });
  for (let i = 0; i < 20 && !got.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(got.slice(0, 1), ["hearth://announcements"]);
  const res = await echo.readResource({ uri: "hearth://announcements" });
  const list = JSON.parse((res.contents[0] as any).text).announcements;
  assert.match(list.at(-1).speech, /Daniel sent you a message: Love you Mom/);
  await echo.close();
});

test("check_medication never logs a dose", async () => {
  const before = await call("show_today");
  const r = await call("check_medication", { medication: "atorvastatin" });
  assert.match(r.content[0].text, /hasn't been logged|isn't due/);
  const after = await call("show_today");
  assert.equal(after.structuredContent.board.takenCount, before.structuredContent.board.takenCount);
});
