import { configJsonSchema, RULES } from "@cheatguard/core";
import { EXIT } from "../errors.js";

export function runRules(): number {
  const width = Math.max(...RULES.map((r) => r.id.length));
  for (const rule of RULES) {
    process.stdout.write(
      `${rule.id.padEnd(width)}  ${rule.defaultSeverity.padEnd(5)}  ${rule.scope.padEnd(7)}  ${rule.description}\n`,
    );
  }
  return EXIT.ok;
}

export function runSchema(): number {
  process.stdout.write(
    `${JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", ...configJsonSchema() }, null, 2)}\n`,
  );
  return EXIT.ok;
}
