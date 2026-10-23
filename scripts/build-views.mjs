// Bundles each MCP App view into a single self-contained HTML file (inline JS + CSS),
// which is what an MCP Apps host loads into its sandboxed iframe.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "views");
const out = join(root, "dist");
mkdirSync(out, { recursive: true });
const base = readFileSync(join(root, "src", "base.css"), "utf8");

for (const name of ["today", "checkin", "refill", "family"]) {
  const result = await build({
    entryPoints: [join(root, "src", `${name}.ts`)],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
    minify: true,
    legalComments: "none",
  });
  const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const css = base + readFileSync(join(root, "src", `${name}.css`), "utf8");
  const title = { today: "Today", checkin: "Check-in", refill: "Refill", family: "Family dashboard" }[name];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hearth · ${title}</title><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
  writeFileSync(join(out, `${name}.html`), html);
  console.log(`views/dist/${name}.html  ${(html.length / 1024).toFixed(1)} KB`);
}
