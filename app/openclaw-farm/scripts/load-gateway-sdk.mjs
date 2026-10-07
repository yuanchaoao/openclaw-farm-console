import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function loadGatewaySdk(packageRoot) {
  if (!packageRoot) throw new Error("OPENCLAW_PACKAGE_ROOT is missing");
  const entry = path.join(packageRoot, "dist", "plugin-sdk", "testing.js");
  if (!fs.existsSync(entry)) throw new Error("compatible OpenClaw SDK entry point is missing");
  // 2026.4.2's testing barrel eagerly imports unrelated Discord/WhatsApp test
  // plugins. Follow its own callGateway re-export, retaining the official
  // implementation without loading those optional integrations.
  const source = fs.readFileSync(entry, "utf8");
  const reexport = source.match(/import\s*\{\s*(\w+)\s+as\s+callGateway\s*\}\s*from\s*["']([^"']+)["']/);
  if (reexport) {
    const target = path.resolve(path.dirname(entry), reexport[2]);
    const dist = path.resolve(packageRoot, "dist") + path.sep;
    if (!target.startsWith(dist)) throw new Error("invalid OpenClaw SDK module path");
    const module = await import(pathToFileURL(target).href);
    if (typeof module[reexport[1]] !== "function") throw new Error("OpenClaw SDK callGateway export is unavailable");
    return { callGateway: module[reexport[1]] };
  }
  const module = await import(pathToFileURL(entry).href);
  if (typeof module.callGateway !== "function") throw new Error("OpenClaw SDK callGateway export is unavailable");
  return module;
}
