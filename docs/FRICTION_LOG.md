# Friction log

Real friction hit while building Hearth and ShowBench during the hackathon, in the format the organizers asked for. Severity is **High** (blocked progress or would block most developers), **Medium** (cost 30+ minutes or caused a wrong design), or **Low** (annoyance).

---

### 1. No way to put a self-hosted MCP server in front of a real Alexa+ device

- **Task:** Show Hearth running on Alexa+ on an Echo Show.
- **Steps:** Read the Alexa+ track resources (the Agent Skills link and the Streamable HTTP spec link). Searched for an Alexa+ developer console entry, an MCP registration flow or a device simulator.
- **Expected:** A way to register an MCP server URL (even a dev-only one) and try it on an Alexa+ device or a simulator, like the classic Alexa Skills Kit test tab.
- **Actual:** Outside the brand Preview there is no path. The track allows a "simulated Alexa+ experience", but every team has to invent their own simulator.
- **Severity:** High
- **Workaround:** Built ShowBench, an open-source smart-display MCP Apps host, and used it for the demo.
- **Suggestion:** Publish an "Alexa+ MCP test console", even text-only, that connects to a public MCP URL and shows how Alexa+ calls tools, renders cards and handles confirmation. It would also standardise what "works on Alexa+" means for judges.

### 2. Which spec version am I actually on? SDK v2 docs vs negotiated version

- **Task:** Make sure the server implements MCP 2025-11-25 as the rules require.
- **Steps:** Installed `@modelcontextprotocol/ext-apps@2`, which peers on the v2 split SDK (`@modelcontextprotocol/server`, `client`, `core`, `node`). The server README says it implements the **2026-07-28** spec. `LATEST_PROTOCOL_VERSION` in core is `2025-11-25`.
- **Expected:** One clear statement of which version is negotiated by default and how to pin it.
- **Actual:** Had to read compiled `core/dist` and capture the raw `initialize` response to confirm `protocolVersion: "2025-11-25"`. Several context APIs (`ctx.mcpReq.elicitInput`, `log`) are marked deprecated "as of 2026-07-28", which makes it hard to know what is safe to use for a 2025-11-25 integration.
- **Severity:** Medium
- **Workaround:** A raw `curl` initialize in CI-style tests, plus an end-to-end test that asserts the negotiated version.
- **Suggestion:** For the hackathon resources, pin a known-good SDK/ext-apps version pair for 2025-11-25 and show the expected `initialize` result.

### 3. `AppBridge.setHostContext()` before `connect()` throws an unhandled "Not connected"

- **Task:** Host an MCP App with a full `hostContext` (device size, touch, theme).
- **Steps:** `new AppBridge(...)`, then `bridge.setHostContext({...})`, then `bridge.connect(transport)`.
- **Expected:** The context is stored and returned in the `ui/initialize` result.
- **Actual:** `setHostContext` also tries to send `ui/notifications/host-context-changed`, which rejects with `SdkError: Not connected` as an unhandled page error.
- **Severity:** Medium
- **Workaround:** Pass `{ hostContext }` in the constructor's `HostOptions` (found by reading the `.d.ts`).
- **Suggestion:** Make `setHostContext` buffer silently before connect, or document the constructor option in the host guide.

### 4. Sandbox proxy race: `sandbox-proxy-ready` is lost if the bridge connects after iframe `load`

- **Task:** Implement the web-host sandbox proxy described in the MCP Apps spec.
- **Steps:** Created the iframe, waited for `load`, then connected `AppBridge` with a `PostMessageTransport`.
- **Expected:** The bridge receives `ui/notifications/sandbox-proxy-ready`.
- **Actual:** The proxy's script posts "ready" before `load` fires, so the view never initialises. There is no error, just an 8-second timeout.
- **Severity:** Medium
- **Workaround:** Connect the bridge to `iframe.contentWindow` first, then set `src`.
- **Suggestion:** Say "connect before navigating" in the spec's sandbox section, or have proxies re-send ready until acknowledged.

### 5. Views without an `onteardown` handler answer `-32601 Method not found`

- **Task:** Replace one view with another cleanly.
- **Steps:** Host sends `ui/resource-teardown` (a request, per the spec examples).
- **Actual:** The default `App` returns `-32601` unless the view registers `onteardown`. The spec calls it a notification in one place and shows it with an `id` in another.
- **Severity:** Low
- **Workaround:** Register `onteardown` in every view and stop background refreshes there.
- **Suggestion:** Give `App` a default teardown handler and make the spec wording consistent.

### 6. Resource subscriptions have no high-level API in the v2 server SDK

- **Task:** Proactive announcements: `resources/subscribe` plus `notifications/resources/updated`.
- **Steps:** Looked for `server.registerResource(..., { subscribe })` or similar.
- **Actual:** You must declare `capabilities.resources.subscribe` yourself and register raw `resources/subscribe` / `resources/unsubscribe` handlers via `server.server.setRequestHandler`. You also have to track subscriptions per session.
- **Severity:** Low
- **Workaround:** About 20 lines in `src/tools.ts`, plus an end-to-end test.
- **Suggestion:** A `subscribable: true` option on `registerResource` and a `server.notifyResourceUpdated(uri)` helper.

### 7. MCP App bundles are ~590 KB each

- **Task:** Ship four small vanilla-TS views.
- **Actual:** Importing `App` pulls in the schema library, so each single-file view is about 590 KB. That's heavy for smart displays on home Wi-Fi.
- **Severity:** Low
- **Workaround:** None yet (minified with esbuild).
- **Suggestion:** A lightweight `App` entry point without runtime schema validation for production views.

### 8. "Agent Skills" means two different things in the resources

- **Task:** Decide what "build an Agent Skill" means for the Alexa+ track.
- **Steps:** The resource link points to the MCP Apps API docs anchor "Build with Agent Skills" (skills that help *coding agents* build MCP Apps). The track text says "a self-hosted MCP server or an Agent Skill" as the deliverable.
- **Expected:** One definition.
- **Actual:** Unclear whether this means an agentskills.io `SKILL.md` that Alexa+ would load, a classic Alexa skill, or the build-helper skills.
- **Severity:** Medium
- **Workaround:** Shipped both an MCP server and an agentskills.io-format `SKILL.md` that the simulator loads into the agent at runtime.
- **Suggestion:** One paragraph in the Alexa+ track describing how Alexa+ consumes Agent Skills, with a minimal example.

### 9. AWS promotional credits ran out on Oct 7

- **Task:** Enter the AWS Builder mini challenge.
- **Actual:** Credits were exhausted two weeks before the deadline. Without an AWS account we couldn't use Bedrock or AgentCore, so we skipped the mini challenge rather than claim an integration we couldn't run.
- **Severity:** Medium (for late joiners)
- **Suggestion:** Keep a small pool for the final two weeks, or offer a hackathon Bedrock sandbox.
