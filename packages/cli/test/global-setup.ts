import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const require = createRequire(join(cwd, "package.json"));
  const pkgPath = require.resolve("tsup/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin.tsup ?? "");
  execFileSync(process.execPath, [join(dirname(pkgPath), bin)], { cwd, stdio: "ignore" });
}
