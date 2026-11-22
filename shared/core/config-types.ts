export interface ResolvedConfig {
  scriptText?: string;
  scriptFile?: string;
  recordFile?: string;
  probeFile?: string;
  alignment: "warn" | "strict" | "ignore";
  delayScale?: number;
}
