import { z } from "zod";
import { LINT_TOOLS, RULE_IDS } from "../types.js";

const severity = z.enum(["block", "warn", "off"]);
const lintTool = z.enum(LINT_TOOLS);

export const configSchema = z
  .object({
    $schema: z.string().optional(),
    rules: z.partialRecord(z.enum(RULE_IDS), severity).optional(),
    scope: z
      .object({ allow: z.array(z.string()).optional() })
      .strict()
      .optional(),
    tests: z
      .object({ patterns: z.array(z.string()).optional() })
      .strict()
      .optional(),
    ignore: z.array(z.string()).optional(),
    lint: z
      .object({
        tools: z.union([z.array(lintTool), z.literal("auto")]).optional(),
        onEdit: z.array(lintTool).optional(),
        onStop: z.array(lintTool).optional(),
        maxDiagnostics: z.number().int().positive().optional(),
        blockOnStop: z.boolean().optional(),
      })
      .strict()
      .optional(),
    hooks: z
      .object({
        maxStopBlocks: z.number().int().positive().optional(),
        warnAgentOnStop: z.boolean().optional(),
        baselineWaitSeconds: z.number().int().min(0).max(240).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type UserConfig = z.infer<typeof configSchema>;
