# Devpost submission: copy-paste fields

**Project name:** Hearth: a care circle for Alexa+

**Elevator pitch (≤200 chars):**
Aging parents manage meds & check-ins by voice on Echo Show; their family gets smart alerts, refills and a live dashboard. An MCP server with MCP Apps, proactive speech & an Agent Skill.

**Track:** Alexa+ · **Mini challenge:** Open Source

**Video:** VIDEO_URL

**Code:** https://github.com/GITHUB_USER/hearth-alexa (MIT) · Open-source contribution: https://github.com/GITHUB_USER/showbench (MIT)

**Built with:** typescript, node.js, model-context-protocol, mcp-apps, streamable-http, agent-skills, server-sent-events, esbuild, web-speech-api

---

## About the project

### Inspiration
In 2025 Amazon retired **Alexa Together**, its remote-caregiving subscription. The need it served keeps growing:
- **63 million Americans** are family caregivers (AARP & NAC, 2025), many of them caring from another city.
- **Half of US prescriptions aren't taken as prescribed**, at an estimated **$100–300 billion a year** (Bosworth et al., *American Heart Journal*, 2011).

And someone already pays for adherence: Medicare Part D Star Ratings score plans on adherence to exactly Rosa's three drug classes (diabetes medications, RAS antagonists, statins), each triple-weighted. So Hearth can be **free for families and sponsored by Medicare Advantage plans and pharmacies**, which could also ship it as their own branded Alexa+ experience.

The Echo Show already sits in the kitchens of the people who need help most. Alexa+ can now hold a real conversation and render rich cards. We wanted to give it a care brain that a son in Seattle can trust for his mom in Tucson.

### What it does
Hearth is a self-hosted **MCP server** that Alexa+ (or any MCP-Apps host) talks to.

- **Rosa, 78, on her Echo Show:**
  - *"I took my morning pills"* logs every dose due.
  - *"Did I take my metformin? I can't remember"* answers from the record, never logs anything, and tells her not to take another. The **double-dose guard** lives in the server, not just a prompt.
  - *"Let's do my check-in"* asks three big-button questions, one at a time.
  - *"Order more metformin"* reads back a quote, then waits for an explicit *yes* before ordering.
- **Hearth speaks up on its own.** When the 7 PM pill isn't logged, her Echo says *"Rosa, it's time for your blood sugar pill"*. This is delivered as an MCP **resource subscription** (`resources/subscribe` → `notifications/resources/updated`).
- **Daniel and Ana, her kids:**
  - They get alerts on an **escalation ladder**: Echo reminder at +30 min, primary caregiver at +60, whole family at +120. Family **quiet hours** are respected.
  - Loops get closed: *"✅ Rosa took Metformin. No action needed."*
  - A pain report becomes *"a call might help"*, never a diagnosis.
  - Daniel's notes are spoken on Mom's Echo.
  - *"Alexa, how's Mom doing this week?"* opens a **family dashboard** MCP App: 7-day adherence grid, mood trend, one-tap refill confirmation.
- **An autonomous care loop** (`run_care_rounds`) runs every 15 minutes like an Alexa+ routine. It handles escalation, check-in nudges and refill forecasting, and is idempotent, so nobody is ever texted twice.

### How we built it
- **MCP spec 2025-11-25 over Streamable HTTP** with the official TypeScript SDK (v2). It uses stateful sessions, Origin validation, and a standalone SSE stream for server push. We verified the negotiated version on the raw wire.
- **14 tools** with Zod schemas and safety annotations, server `instructions`, a care-plan resource, and two prompts.
- **4 MCP Apps views** in vanilla TypeScript, each bundled to a single HTML file:
  - **Today**: a sun-arc timeline of her day, with doses as beads.
  - **Check-in**
  - **Refill**: a purchase card with a live price-hold countdown.
  - **Family dashboard**

  The views call tools back, push context to the assistant with `ui/update-model-context` ("she tapped *I took it* on screen"), use app-only tools (`visibility: ["app"]`) to stay live, and handle teardown.
- **An Agent Skill** (`SKILL.md`, agentskills.io format) holds the voice rules (one question at a time, two sentences max), the non-negotiable safety rules, and worked examples. It's loaded into the agent at runtime.
- **ShowBench**, our open-source simulated Alexa+ device. No public way exists to point a real Alexa+ device at a self-hosted MCP server, so we built a spec-compliant MCP Apps host for smart displays:
  - a cross-origin sandbox proxy with CSP
  - Echo Show and Fire TV screen profiles
  - Web Speech voice in and out, a light bar and captions
  - proactive announcements via `resources/subscribe`
  - a live protocol inspector for both wires
  - an LLM planner (Anthropic or any OpenAI-compatible model) that loads the server's instructions and Agent Skill, plus a deterministic offline planner for keyless demos and CI
- **Cross-service orchestration** through adapters: family notifications via webhook (n8n, Zapier, ntfy, SMS gateways) and a pharmacy adapter (a clearly labelled sandbox in the demo).
- **Tests:**
  - 9 end-to-end tests: real server, real MCP client, real Streamable HTTP. They cover version negotiation, MCP Apps metadata, the double-dose guard, the escalation ladder and its idempotency, the purchase flow, cross-session persistence, and proactive push.
  - LLM-adapter contract tests against fake Anthropic and OpenAI endpoints.
- The demo video was recorded headlessly from ShowBench's scripting API, with open-source TTS voices.
- We used Claude as a pair programmer throughout. Commits are co-authored.

### Challenges we ran into
- There's **no developer path to test a self-hosted MCP server on a real Alexa+ device**, so we built ShowBench.
- Two undocumented ordering issues in MCP Apps hosting:
  - `setHostContext` before connect throws.
  - The sandbox proxy's "ready" message is lost if you connect after the iframe loads.
- Designing safety into the **server**, not the prompt. "Did I take it?" had to become its own read-only tool, so an anxious question can never be recorded as a dose.
- Making an escalation loop that is **idempotent and quiet-hours aware**, so it can run every 15 minutes forever without spamming a family.

### Accomplishments that we're proud of
- The evening sequence runs without anyone asking:
  1. Rosa's Echo speaks up on its own.
  2. Daniel's phone buzzes 30 minutes later.
  3. His note is read aloud on her Echo.
  4. She takes the pill.
  5. He gets the all-clear.
- One MCP server serves Rosa's Echo, Daniel's Echo, his phone, and any MCP-Apps host.
- ShowBench is a genuinely reusable tool for anyone building MCP Apps for displays and TVs.

### What we learned
- MCP Apps turns voice-assistant development into normal web and back-end engineering. The interesting work moves to **care design**: who gets told what, when, and how the loop closes.
- Voice UX for older adults rewards restraint: short sentences, one question, no lectures, big targets.

### What's next for Hearth
- Alexa+ account linking and per-speaker identity: Rosa versus a visiting nurse.
- Real pharmacy integrations behind the existing adapter.
- Ring: "Rosa went out for her walk" as a gentle wellbeing signal.
- Fire TV: the evening reminder as a picture-in-picture card during her shows.
- Spanish: Rosa's first language.

---

## Was this project started before the hackathon?
No. Hearth and ShowBench were both created during the submission window (October 2026). See the commit history.

## Open Source mini challenge fields
- **Contribution URL:** https://github.com/GITHUB_USER/showbench
- **Project repository URL:** https://github.com/GITHUB_USER/hearth-alexa
- **GitHub username:** GITHUB_USER
- **What we did, how it works, why it matters:** ShowBench is a new open-source (MIT) voice and smart-display host for testing MCP servers and MCP Apps the way they'll run on Alexa+ class devices.
  - **How it works:**
    - It connects to any MCP server over Streamable HTTP (spec 2025-11-25).
    - It renders MCP Apps through a spec-compliant cross-origin sandbox proxy with CSP, on Echo Show 5/8/15 or Fire TV screen profiles.
    - It talks and listens with the Web Speech API.
    - It speaks proactive announcements via `resources/subscribe`.
    - It shows every JSON-RPC frame on both the MCP and MCP Apps wires.
    - It plans with any LLM (Anthropic or OpenAI-compatible) using the server's instructions and an Agent Skill, or with deterministic intent rules for keyless demos and CI.
  - **Why it matters:** today, outside the Alexa+ Preview, developers can't see their MCP Apps on a display form factor, hear them, or test proactive behaviour. Desktop chat hosts render apps in a narrow column with a mouse. ShowBench gives every Alexa+, Echo Show and Fire TV builder a free local test bench.

## Product feedback
Paste from [PRODUCT_FEEDBACK.md](PRODUCT_FEEDBACK.md).

## Feature requests
Paste the table from [PRODUCT_FEEDBACK.md](PRODUCT_FEEDBACK.md#feature-requests).

## Friction log
Paste from [FRICTION_LOG.md](FRICTION_LOG.md).
