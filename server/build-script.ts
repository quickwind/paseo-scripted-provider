import { BUILTIN_SCRIPT } from "../shared/core/builtins";
import type { Script } from "../shared/core/schema";
import { mergeScripts, parseScript } from "../shared/core/script";
import { loadScriptTexts } from "./config";
import type { ResolvedConfig } from "../shared/core/config-types";

export interface BuiltScript {
  script: Script;
  error: string | null;
}

/** Built-ins merged with the user's file and inline scripts. An invalid source never breaks the provider. */
export function buildScript(cfg: ResolvedConfig, read?: (p: string) => string): BuiltScript {
  let script = BUILTIN_SCRIPT;
  const errors: string[] = [];
  for (const text of loadScriptTexts(cfg, read)) {
    const parsed = parseScript(text);
    if (parsed.ok) script = mergeScripts(script, parsed.script);
    else errors.push(parsed.error);
  }
  return { script, error: errors.length ? errors.join("; ") : null };
}
