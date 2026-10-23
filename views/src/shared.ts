import { App } from "@modelcontextprotocol/ext-apps";

export type Payload = Record<string, any>;

/** True once the host has torn this view down; background refreshes stop. */
export let torndown = false;

/**
 * Connect a Hearth view to its MCP Apps host. Renders on the initial tool result,
 * re-renders when the host pushes a new result, and adapts to host theme.
 */
export async function connectView(name: string, render: (data: Payload, app: App) => void) {
  const app = new App({ name: `hearth-${name}`, version: "1.0.0" }, {}, { autoResize: true });
  app.ontoolresult = (result) => {
    const data = (result.structuredContent ?? {}) as Payload;
    if (data && Object.keys(data).length) render(data, app);
  };
  app.onhostcontextchanged = (ctx) => applyHostContext(ctx as Payload);
  app.onteardown = async () => {
    torndown = true;
    return {};
  };
  await app.connect();
  applyHostContext((app.getHostContext() ?? {}) as Payload);
  return app;
}

function applyHostContext(ctx: Payload) {
  if (ctx.theme) document.documentElement.dataset.theme = ctx.theme;
  if (ctx.platform) document.documentElement.dataset.platform = ctx.platform;
}

export function h(tag: string, attrs: Record<string, any> = {}, ...children: (Node | string | null | undefined | false)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}

export function svg(tag: string, attrs: Record<string, any> = {}, ...children: Node[]) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

export function mount(node: Node) {
  const root = document.getElementById("root")!;
  root.replaceChildren(node);
}

export function relTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs} h ago` : `${Math.round(hrs / 24)} d ago`;
}

export const STATUS_WORDS: Record<string, string> = {
  taken: "Taken",
  skipped: "Skipped",
  upcoming: "Later",
  due: "Take now",
  late: "Late",
  missed: "Missed",
};
