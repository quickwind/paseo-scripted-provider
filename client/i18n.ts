import * as pluginClient from "@getpaseo/plugin/client";

/**
 * Plugin translations (Paseo 0.13+). English is the source; every other locale must use the same keys and
 * `{{placeholders}}`. Hosts older than 0.13 have neither `defineTranslations` nor `client.i18n`, so the same
 * keys fall back to English there and the plugin keeps working on Paseo >= 0.11.
 */
export const resources = {
  en: {
    settings: {
      title: "Scripted provider",
      intro: 'Pick the "Scripted" provider when creating an agent and choose a scenario as the model. Send SCENARIO:name in chat to switch.',
      loadFailed: "Could not load settings: {{error}}",
      resetDefaults: "Reset to defaults",
      script: "Script (YAML or JSON)",
      scriptHint: "Leave empty to use only the built-in scenarios. The script is merged over them.",
      scriptFile: "Script file (optional)",
      recordFile: "Received-messages log file (optional)",
      alignment: "When a replayed prompt differs from the recorded one",
      alignmentOption: { warn: "warn", strict: "strict", ignore: "ignore" },
      changedElsewhere: 'These settings changed elsewhere (for example by "Replay now"). Saving would overwrite them.',
      reload: "Reload",
      save: "Save",
      saving: "Saving…",
      scriptProblem: "Script problem (built-ins in use): {{error}}",
      scenarios: "Scenarios: {{list}}",
      received: "Received messages",
      refresh: "Refresh",
      nothingRecorded: "Nothing recorded yet (set a log file above).",
    },
    commands: {
      nextDescription: "Advance the Scripted agent by one step",
      resetDescription: "Restart the Scripted agent's scenario (optionally switch to another)",
    },
    record: {
      screenTitle: "Record as script",
      buttonTitle: "Record this conversation as a replayable script (secrets are redacted before export)",
      buttonLabel: "Record as script",
      openFromConversation: 'Open this from a conversation: use the "Record as script" button next to the message box.',
      setupTitle: "Record this conversation as a script",
      setupIntro: "The script can be replayed on a Scripted agent. Secrets are replaced before anything is exported; you review every change first.",
      scriptName: "Script name",
      lastTurns: "Only the last N turns (blank = all)",
      lastTurnsPlaceholder: "e.g. 3",
      delays: "Delays",
      delayKeep: "Keep",
      delayScale: "Scale",
      delayRemove: "Remove",
      scaleFactor: "Scale factor",
      reasoningOn: "Reasoning: included",
      reasoningOff: "Reasoning: skipped",
      toolOutputOn: "Tool output: included",
      toolOutputOff: "Tool output: skipped",
      truncate: "Truncate long text at N characters (blank = never)",
      reading: "Reading…",
      preview: "Preview & redact",
      readFailed: "Could not read the session: {{error}}",
      serializeFailed: "Could not serialize the script: {{error}}",
      downloaded: "Script downloaded",
      copied: "Script copied to the clipboard — paste it into a file to keep it",
      settingsNotLoaded: "Settings are not loaded yet; try again in a moment",
      buildFailed: "Could not build the script: {{error}}",
      existingInvalid: "Existing script is invalid: {{error}}",
      unknownError: "unknown error",
      saveFailed: "Could not save the script",
      replayTitle: "Replay: {{name}}",
      replayCreated: "Replay agent created ({{name}}). Send the same messages and it answers by content.",
      replayAgentFailed: 'Script saved as "{{name}}", but creating the agent failed: {{error}}',
      redactedItems: "Redacted {{count}} item(s)",
      keptItems: "Kept {{count}} item(s) as they are",
      reviewTitle: 'Review "{{name}}"',
      redactionWarning: "Redaction is best-effort and cannot guarantee that nothing sensitive remains. Review every step before sharing or committing the file. Nothing is uploaded.",
      back: "Back",
      download: "Download .{{format}}",
      copy: "Copy {{format}}",
      chooseFormat: "Choose the export format",
      closeFormatMenu: "Close the format menu",
      replayNow: "Replay now",
      toConfirm: "To confirm ({{open}}/{{total}})",
      replaced: "Replaced ({{count}})",
      previous: "◀ Previous",
      next: "Next ▶",
      none: "none",
      redact: "Redact",
      keepAsIs: "Keep as is",
      redactAll: "Redact all ({{count}})",
      keepAll: "Keep all as is ({{count}})",
      keepAllConfirm: "Tap again to keep all {{count}} as is",
      redactAgain: "Redact again",
      restoreOriginal: "Restore original",
      nothingToConfirm: "Nothing left to confirm. You can export.",
      mustConfirm: "{{count}} item(s) must be confirmed (Redact or Keep) before export.",
      selected: "Selected: step {{step}} · {{kind}} · {{display}}",
      kindSecret: "looks like a secret",
      kindReplaced: "replaced value",
      state: { active: "active", pending: "check", replaced: "replaced", kept: "kept", restored: "restored" },
      legend: {
        active: "the item you selected",
        pending: "looks like a secret — Redact or Keep it",
        replaced: "replaced automatically (tap to restore the original)",
        kept: "you chose to keep it as is",
        restored: "original restored — it will be exported",
      },
      step: "Step {{step}}",
      edit: "Edit",
      redactSelection: "Redact selection",
      cancel: "Cancel",
      itemsToConfirm: "Items to confirm — tap to jump to them",
      replacedValues: "Replaced values — tap to jump to them",
      nothingHere: "Nothing here.",
    },
  },
  "zh-CN": {
    settings: {
      title: "剧本回放（Scripted）",
      intro: "创建智能体时选择“Scripted”模型供应商，并选择一个场景作为模型。在聊天中发送 SCENARIO:名称 即可切换场景。",
      loadFailed: "无法加载设置：{{error}}",
      resetDefaults: "恢复默认值",
      script: "剧本（YAML 或 JSON）",
      scriptHint: "留空则只使用内置场景。剧本会合并到内置场景之上。",
      scriptFile: "剧本文件（可选）",
      recordFile: "收到消息的日志文件（可选）",
      alignment: "当回放的提示词与录制的不一致时",
      alignmentOption: { warn: "警告", strict: "严格", ignore: "忽略" },
      changedElsewhere: "这些设置已在其他地方被修改（例如通过“立即回放”）。保存会覆盖它们。",
      reload: "重新加载",
      save: "保存",
      saving: "正在保存…",
      scriptProblem: "剧本有问题（正在使用内置场景）：{{error}}",
      scenarios: "场景：{{list}}",
      received: "收到的消息",
      refresh: "刷新",
      nothingRecorded: "尚无记录（请在上方设置日志文件）。",
    },
    commands: {
      nextDescription: "让 Scripted 智能体前进一步",
      resetDescription: "重新开始 Scripted 智能体的场景（可选切换到其他场景）",
    },
    record: {
      screenTitle: "录制为剧本",
      buttonTitle: "将此对话录制为可回放的剧本（导出前会先脱敏密钥）",
      buttonLabel: "录制为剧本",
      openFromConversation: "请从对话中打开：使用消息输入框旁的“录制为剧本”按钮。",
      setupTitle: "将此对话录制为剧本",
      setupIntro: "该剧本可在 Scripted 智能体上回放。导出前会替换其中的密钥，你会先审核每一处改动。",
      scriptName: "剧本名称",
      lastTurns: "仅最近 N 轮（留空 = 全部）",
      lastTurnsPlaceholder: "例如 3",
      delays: "延迟",
      delayKeep: "保留",
      delayScale: "缩放",
      delayRemove: "移除",
      scaleFactor: "缩放系数",
      reasoningOn: "推理过程：已包含",
      reasoningOff: "推理过程：已跳过",
      toolOutputOn: "工具输出：已包含",
      toolOutputOff: "工具输出：已跳过",
      truncate: "在 N 个字符处截断长文本（留空 = 不截断）",
      reading: "正在读取…",
      preview: "预览并脱敏",
      readFailed: "无法读取会话：{{error}}",
      serializeFailed: "无法序列化剧本：{{error}}",
      downloaded: "剧本已下载",
      copied: "剧本已复制到剪贴板——请粘贴到文件中保存",
      settingsNotLoaded: "设置尚未加载，请稍后再试",
      buildFailed: "无法生成剧本：{{error}}",
      existingInvalid: "现有剧本无效：{{error}}",
      unknownError: "未知错误",
      saveFailed: "无法保存剧本",
      replayTitle: "回放：{{name}}",
      replayCreated: "已创建回放智能体（{{name}}）。发送相同的消息，它会按内容作答。",
      replayAgentFailed: "剧本已保存为“{{name}}”，但创建智能体失败：{{error}}",
      redactedItems: "已脱敏 {{count}} 项",
      keptItems: "已保持 {{count}} 项原样",
      reviewTitle: "审核“{{name}}”",
      redactionWarning: "脱敏只是尽力而为，不能保证不残留敏感信息。分享或提交文件前请逐步审核。不会上传任何内容。",
      back: "返回",
      download: "下载 .{{format}}",
      copy: "复制 {{format}}",
      chooseFormat: "选择导出格式",
      closeFormatMenu: "关闭格式菜单",
      replayNow: "立即回放",
      toConfirm: "待确认（{{open}}/{{total}}）",
      replaced: "已替换（{{count}}）",
      previous: "◀ 上一个",
      next: "下一个 ▶",
      none: "无",
      redact: "脱敏",
      keepAsIs: "保持原样",
      redactAll: "全部脱敏（{{count}}）",
      keepAll: "全部保持原样（{{count}}）",
      keepAllConfirm: "再点一次，将全部 {{count}} 项保持原样",
      redactAgain: "重新脱敏",
      restoreOriginal: "恢复原值",
      nothingToConfirm: "没有待确认的内容，可以导出。",
      mustConfirm: "导出前必须确认 {{count}} 项（脱敏或保持原样）。",
      selected: "已选中：第 {{step}} 步 · {{kind}} · {{display}}",
      kindSecret: "疑似密钥",
      kindReplaced: "已替换的值",
      state: { active: "选中", pending: "待查", replaced: "已替换", kept: "已保持", restored: "已恢复" },
      legend: {
        active: "你选中的项目",
        pending: "疑似密钥——请选择脱敏或保持原样",
        replaced: "已自动替换（点按可恢复原值）",
        kept: "你选择了保持原样",
        restored: "已恢复原值——将按原样导出",
      },
      step: "第 {{step}} 步",
      edit: "编辑",
      redactSelection: "脱敏所选内容",
      cancel: "取消",
      itemsToConfirm: "待确认项——点按可跳转",
      replacedValues: "已替换的值——点按可跳转",
      nothingHere: "这里没有内容。",
    },
  },
};

type Paths<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Paths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];
export type MessageKey = Paths<typeof resources.en>;
export type MessageValues = Record<string, string | number>;

type Translations = { message(key: string, values?: MessageValues): unknown };
type Host = {
  defineTranslations?: (definition: { resources: typeof resources }) => Translations;
  useTranslation?: (messages: Translations) => { t(key: string, values?: MessageValues): string };
};
const host = pluginClient as unknown as Host;

/** Defined once; undefined on hosts older than Paseo 0.13. */
export const translations = typeof host.defineTranslations === "function" ? host.defineTranslations({ resources }) : undefined;

function lookup(tree: unknown, key: string): string | undefined {
  let node = tree;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

export function interpolate(template: string, values: MessageValues = {}): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}

/** English text, for hosts without plugin translations. */
export function english(key: string, values?: MessageValues): string {
  return interpolate(lookup(resources.en, key) ?? key, values);
}

/** A label for a contribution: a host-resolved message on Paseo 0.13+, English before that. */
export function label(key: MessageKey, values?: MessageValues): string {
  return (translations ? translations.message(key, values) : english(key, values)) as string;
}

/** Translate inside a component; follows the app language on Paseo 0.13+. The host picks one branch for the whole session, so the hook order is stable. */
export function useT(): (key: MessageKey, values?: MessageValues) => string {
  if (translations && host.useTranslation) return host.useTranslation(translations).t;
  return english;
}
