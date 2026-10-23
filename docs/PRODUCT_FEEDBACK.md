# Product feedback

## Tools, APIs and SDKs used, and what for

| Tool | Used for |
|---|---|
| **Model Context Protocol, spec 2025-11-25** (Streamable HTTP transport) | The Hearth server: stateful sessions, standalone SSE stream for server push, tools, resources, prompts, server instructions, `resources/subscribe` |
| **MCP TypeScript SDK v2** (`@modelcontextprotocol/server`, `client`, `core`, `node`) | Server (`McpServer`, `NodeStreamableHTTPServerTransport`) and both clients (ShowBench host, end-to-end tests) |
| **MCP Apps extension** (`@modelcontextprotocol/ext-apps`, spec 2026-01-26) | 4 Hearth views (`App`), server helpers (`registerAppTool`, `registerAppResource`), and ShowBench's host side (`AppBridge`, `PostMessageTransport`) |
| **Agent Skills** (agentskills.io `SKILL.md` format) | `hearth-care-circle` skill: voice rules, safety rules, routines and examples. ShowBench loads it into the agent's system prompt |
| **Alexa+ track docs** (Agent Skills + Streamable HTTP links) | Requirements and the simulated-experience path |

No AWS services were used (credits were exhausted), so we did not enter AWS Builder.

## What worked well

- **Streamable HTTP is a great fit for a home device.** Sessions, a standalone SSE stream for proactive pushes, and plain POSTs for tool calls. Our server-push test (Echo subscribes, family member sends a note, Echo gets `resources/updated` within ~100 ms) passed first time.
- **MCP Apps is the right abstraction for Echo Show.** A tool declares `_meta.ui.resourceUri`, the host renders it, and the view calls tools back. Several features made rich, safe display UX straightforward:
  - `visibility: ["app"]`, for view-only refresh tools
  - `ui/update-model-context`, which tells the assistant "she tapped *I took it* on screen"
  - `containerDimensions`
- **`registerAppTool` / `registerAppResource`** remove the boilerplate, including the legacy `ui/resourceUri` key.
- **Tool annotations** (`readOnlyHint`, `idempotentHint`, `openWorldHint`) let us express "this purchase is not idempotent" and "this check never writes" in a host-readable way.
- **The spec's sandbox-proxy section** is precise enough to implement a compliant web host in about 60 lines.

## What needs work

See [FRICTION_LOG.md](FRICTION_LOG.md) for full entries. In short:
- **No Alexa+ test path for outside developers** (the biggest gap). Every team must build its own simulator.
- **SDK v2 version messaging**: README says 2026-07-28, while 2025-11-25 is negotiated. Deprecation notes make it unclear what's safe for a 2025-11-25 integration.
- **`AppBridge.setHostContext` before connect** throws an unhandled "Not connected". The constructor option isn't in the guide.
- **Sandbox proxy ready race**: connect-before-navigate isn't documented.
- **Teardown** is notification vs request in the spec, and `App` has no default handler (`-32601`).
- **No high-level resource subscription API** in the v2 server.
- **~590 KB per MCP App view** because of bundled schema validation.
- **"Agent Skills" is ambiguous** in the Alexa+ track resources.

## Onboarding (zero to hello world)

- **MCP server over Streamable HTTP:** about 20 minutes, mostly confirming the negotiated version.
- **First MCP App rendering in our own host:** about 90 minutes. Two undocumented ordering issues (host context, sandbox ready) took most of it. With an existing host like Claude it would be minutes.
- **Alexa+ itself:** not possible outside the Preview, so we built the simulated path.

## Would we build with these again?

**Yes.** MCP plus MCP Apps is the first time a voice assistant integration feels like normal web and back-end engineering: one server works for Alexa+, desktop assistants and our own simulator, with rich cards and real state. We'd ship Hearth to Alexa+ the day a developer path opens. The main ask is that test path.

## Feature requests

| Request | Why it matters for Hearth | Priority |
|---|---|---|
| Alexa+ MCP developer test console (register a URL, test on device or in a simulator) | Proves the integration on the real assistant; today only Preview brands can | **Critical** |
| Proactive notifications for MCP servers on Alexa+ (map `resources/updated` or a dedicated capability to Alexa announcements, with user opt-in and quiet hours) | Medication reminders and family messages must be spoken without being asked | **Critical** |
| Per-speaker identity passed to MCP servers (voice ID → stable user id) | Rosa, a visiting nurse and Daniel need different permissions on the same Echo | Important |
| A standard confirmation primitive for purchases on voice (host-rendered "Confirm $4?" with a signed token) | Every purchase server reinvents quote/confirm; a host-level primitive is safer | Important |
| Lightweight MCP Apps runtime for display devices | 590 KB per view is heavy on home Wi-Fi | Nice-to-have |
| Echo Show device profile in the MCP Apps `hostContext` (screen class, distance-viewing hint) | Lets views pick type size for 2-metre viewing | Nice-to-have |
