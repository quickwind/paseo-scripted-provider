import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { ScrollView, TextInput, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import React, { useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions, type ScrollView as NativeScrollView } from "react-native";
import type { ConvertOptions, TimelineEntry } from "../shared/core/capture/convert";
import { safeScenarioName, scriptFilename, type ScriptFormat } from "../shared/core/capture/script-format";
import { captureRpc, exportScriptRpc, mergeScenarioRpc, scriptedSettings } from "../shared/rpc";
import { buildReview, canExport, confirmSuspicious, editStep, exportScript, pendingConfirms, redactSelection, resolveAll, restoreFinding, reviewItems, stepsView, type EditField, type ReviewItem, type ReviewModel } from "./state";
import { useT } from "./i18n";
import { highlight, LEGEND, type HighlightState } from "./palette";
import { canDownload, downloadFile } from "./web";

type Delay = "keep" | "scale" | "drop";
type Tab = "confirm" | "replaced";

const MENU_WIDTH = 120;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const RecordScreen: React.FC<PluginScreenProps> = ({ params, theme, layout, navigation }) => {
  const agentId = params.agentId ?? "";
  const workspaceId = params.workspaceId ?? "";
  const { colors } = theme;
  const t = useT();
  const capture = useRpc(captureRpc);
  const exportScriptRpcCall = useRpc(exportScriptRpc);
  const mergeScenarioRpcCall = useRpc(mergeScenarioRpc);
  const paseo = usePaseo();
  const settings = useSettings(scriptedSettings);
  const toast = useToast();
  const { width, height } = useWindowDimensions();
  const wide = width >= 820 && !layout.compact;

  const [name, setName] = useState("recorded");
  const [lastTurns, setLastTurns] = useState("");
  const [delay, setDelay] = useState<Delay>("keep");
  const [factor, setFactor] = useState("0.1");
  const [reasoning, setReasoning] = useState(true);
  const [toolOutput, setToolOutput] = useState(true);
  const [truncate, setTruncate] = useState("");
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<ReviewModel | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  // The redactor is mutated in place (restore / redact selection); the version makes derived data recompute.
  const [version, setVersion] = useState(0);
  const rerender = () => setVersion((n) => n + 1);
  const [editing, setEditing] = useState<{ index: number; field: EditField; text: string; sel: string } | null>(null);
  const [tab, setTab] = useState<Tab>("confirm");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Keeping everything is the risky bulk action, so it asks for a second tap.
  const [armKeepAll, setArmKeepAll] = useState(false);
  const [format, setFormat] = useState<ScriptFormat>("yaml");
  // The format menu floats over the page at its root (measured position), so opening it never moves anything.
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<View>(null);
  const arrowRef = useRef<View>(null);
  const toggleFormatMenu = () => {
    if (menuPos) return setMenuPos(null);
    rootRef.current?.measureInWindow((rx, ry) => {
      arrowRef.current?.measureInWindow((bx, by, bw, bh) => {
        setMenuPos({ left: Math.max(0, bx - rx + bw - MENU_WIDTH), top: by - ry + bh + 4 });
      });
    });
  };

  const scroller = useRef<NativeScrollView>(null);
  const stepY = useRef<Record<number, number>>({});
  const partY = useRef<Record<string, number>>({});

  const items = useMemo(() => (model ? reviewItems(model) : []), [model, version]);
  const confirms = items.filter((i) => i.kind === "confirm");
  const replaced = items.filter((i) => i.kind === "replaced");
  const list = tab === "confirm" ? confirms : replaced;
  const active = items.find((i) => i.key === activeKey) ?? null;
  const activeIndex = list.findIndex((i) => i.key === activeKey);
  const pending = model ? pendingConfirms(model) : 0;

  const locate = (item: ReviewItem) => {
    setActiveKey(item.key);
    const y = (stepY.current[item.step] ?? 0) + (partY.current[`${item.step}:${item.part}`] ?? 0);
    scroller.current?.scrollTo({ y: Math.max(0, y - 12), animated: true });
  };
  const go = (delta: number) => {
    if (list.length === 0) return;
    const next = activeIndex < 0 ? (delta > 0 ? 0 : list.length - 1) : (activeIndex + delta + list.length) % list.length;
    locate(list[next]);
  };
  /** After resolving an item, move on to the next one that still needs a decision. */
  const nextPending = (from: ReviewItem): ReviewItem | null => {
    const todo = confirms.filter((i) => !i.done && i.key !== from.key);
    if (todo.length === 0) return null;
    const at = confirms.findIndex((i) => i.key === from.key);
    return todo.find((i) => confirms.indexOf(i) > at) ?? todo[0];
  };
  const resolve = (item: ReviewItem, how: "redact" | "keep") => {
    if (!model) return;
    const next = nextPending(item);
    if (how === "redact") redactSelection(model, item.value);
    setModel(confirmSuspicious(model, item.value));
    rerender();
    if (next) setTimeout(() => locate(next), 0);
    else setActiveKey(null);
  };

  const decideAll = (how: "redact" | "keep") => {
    if (!model || pending === 0) return;
    if (how === "keep" && !armKeepAll) {
      setArmKeepAll(true);
      setTimeout(() => setArmKeepAll(false), 4000);
      return;
    }
    setArmKeepAll(false);
    setModel(resolveAll(model, how));
    setActiveKey(null);
    rerender();
    toast.show(how === "redact" ? t("record.redactedItems", { count: pending }) : t("record.keptItems", { count: pending }));
  };

  // Async function expressions, not async arrows: the mobile app's engine has no async arrow functions.
  const preview = async function preview() {
    setBusy(true);
    try {
      const { entries, agent } = await capture({ agentId });
      setCwd(agent?.cwd ?? null);
      const n = Number(lastTurns);
      const options: ConvertOptions = {
        name: safeScenarioName(name),
        lastTurns: lastTurns.trim() && Number.isFinite(n) && n >= 0 ? n : undefined,
        delay: delay === "scale" ? { mode: "scale", factor: Number(factor) > 0 ? Number(factor) : 1 } : { mode: delay },
        includeReasoning: reasoning,
        includeToolOutput: toolOutput,
        truncateAt: Number(truncate) > 0 ? Number(truncate) : undefined,
      };
      setModel(buildReview(entries as TimelineEntry[], options, { cwd: agent?.cwd }));
      setActiveKey(null);
      setTab("confirm");
    } catch (e) {
      toast.error(t("record.readFailed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const doExport = async function doExport() {
    if (!model || !canExport(model)) return;
    let text: string;
    try {
      // The daemon owns the YAML parser, so the client bundle never ships it.
      text = (await exportScriptRpcCall({ script: exportScript(model), format })).text;
    } catch (e) {
      toast.error(t("record.serializeFailed", { error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    if (canDownload) {
      downloadFile(scriptFilename(model.name, new Date(), format), text, format === "yaml" ? "application/yaml;charset=utf-8" : undefined);
      toast.show(t("record.downloaded"));
    } else {
      await copyText(text);
      toast.show(t("record.copied"));
    }
  };

  const doReplay = async function doReplay() {
    if (!model || !canExport(model)) return;
    if (settings.status !== "ready") return toast.error(t("record.settingsNotLoaded"));
    let merged: { ok: boolean; text?: string; name?: string; error?: string };
    try {
      merged = await mergeScenarioRpcCall({
        script: exportScript(model),
        name: model.name,
        existingText: settings.values.scripts,
      });
    } catch (e) {
      toast.error(t("record.buildFailed", { error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    if (!merged.ok || !merged.text || !merged.name) return toast.error(t("record.existingInvalid", { error: merged.error ?? t("record.unknownError") }));
    if (!(await settings.save({ ...settings.values, scripts: merged.text }, settings.revision))) return toast.error(t("record.saveFailed"));
    try {
      const agentOptions = { config: { provider: `scripted/${merged.name}` }, title: t("record.replayTitle", { name: merged.name }) };
      // Create inside the recorded conversation's workspace; a bare cwd would make the host open a new workspace.
      const created = workspaceId
        ? await paseo.workspaces.ref(workspaceId).agents.create(agentOptions)
        : await paseo.agents.create({ cwd: cwd ?? ".", ...agentOptions });
      toast.show(t("record.replayCreated", { name: merged.name }));
      navigation?.openAgent({ agentId: created.id });
    } catch (e) {
      toast.error(t("record.replayAgentFailed", { name: merged.name, error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const btn = (title: string, onPress: () => void, o: { disabled?: boolean; primary?: boolean } = {}) => (
    <Pressable key={title} disabled={o.disabled} onPress={onPress} style={[styles.btn, { borderColor: colors.border, backgroundColor: o.primary ? colors.accent : colors.surface2, opacity: o.disabled ? 0.4 : 1 }]}>
      <Text style={{ color: o.primary ? colors.accentForeground : colors.foreground }}>{title}</Text>
    </Pressable>
  );
  const chip = (title: string, on: boolean, onPress: () => void) => (
    <Pressable key={title} onPress={onPress} style={[styles.btn, { borderColor: colors.border, backgroundColor: on ? colors.accent : colors.surface2 }]}>
      <Text style={{ color: on ? colors.accentForeground : colors.foreground }}>{title}</Text>
    </Pressable>
  );
  const field = (label: string, value: string, set: (v: string) => void, placeholder = "") => (
    <View style={styles.field}>
      <Text style={{ color: colors.foreground }}>{label}</Text>
      <TextInput value={value} onChangeText={set} placeholder={placeholder} autoCapitalize="none" style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface1 }]} />
    </View>
  );

  if (!agentId) {
    return (
      <View style={styles.page}>
        <Text style={{ color: colors.foreground }}>{t("record.openFromConversation")}</Text>
      </View>
    );
  }

  if (!model) {
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.setup}>
          <Text style={[styles.title, { color: colors.foreground }]}>{t("record.setupTitle")}</Text>
          <Text style={{ color: colors.foregroundMuted }}>{t("record.setupIntro")}</Text>
          {field(t("record.scriptName"), name, setName)}
          {field(t("record.lastTurns"), lastTurns, setLastTurns, t("record.lastTurnsPlaceholder"))}
          <Text style={{ color: colors.foreground }}>{t("record.delays")}</Text>
          <View style={styles.row}>
            {chip(t("record.delayKeep"), delay === "keep", () => setDelay("keep"))}
            {chip(t("record.delayScale"), delay === "scale", () => setDelay("scale"))}
            {chip(t("record.delayRemove"), delay === "drop", () => setDelay("drop"))}
          </View>
          {delay === "scale" ? field(t("record.scaleFactor"), factor, setFactor) : null}
          <View style={styles.row}>
            {chip(reasoning ? t("record.reasoningOn") : t("record.reasoningOff"), reasoning, () => setReasoning(!reasoning))}
            {chip(toolOutput ? t("record.toolOutputOn") : t("record.toolOutputOff"), toolOutput, () => setToolOutput(!toolOutput))}
          </View>
          {field(t("record.truncate"), truncate, setTruncate)}
          {btn(busy ? t("record.reading") : t("record.preview"), () => void preview(), { disabled: busy, primary: true })}
        </View>
      </ScrollView>
    );
  }

  const views = stepsView(model);
  const mainHeight = Math.max(360, height - 230);
  const activeValue = active?.value;

  const renderPlain = (text: string, suspicious: string[], key: string) => {
    const toks = suspicious.filter((t) => text.includes(t));
    if (toks.length === 0) return <Text key={key}>{text}</Text>;
    const pieces = text.split(new RegExp(`(${toks.map(escapeRe).join("|")})`));
    return (
      <Text key={key}>
        {pieces.map((p, i) => {
          if (!toks.includes(p)) return <Text key={i}>{p}</Text>;
          const state: HighlightState = p === activeValue ? "active" : model.confirmed.has(p) ? "kept" : "pending";
          const c = highlight(state);
          return (
            <Text key={i} style={{ backgroundColor: c.bg, color: c.fg, fontWeight: state === "active" ? "700" : "400" }}>{p}</Text>
          );
        })}
      </Text>
    );
  };

  const stateOf = (item: ReviewItem): HighlightState =>
    item.key === activeKey ? "active" : item.kind === "confirm" ? (item.done ? "kept" : "pending") : item.restored ? "restored" : "replaced";

  const itemRow = (item: ReviewItem) => {
    const c = highlight(stateOf(item));
    return (
      <Pressable key={item.key} onPress={() => locate(item)} style={[styles.itemRow, { borderColor: item.key === activeKey ? c.bg : colors.border, borderWidth: item.key === activeKey ? 2 : 1, backgroundColor: colors.surface1 }]}>
        <Text style={{ color: colors.foreground }} numberOfLines={1}>
          <Text style={{ backgroundColor: c.bg, color: c.fg }}> {t(`record.state.${item.kind === "confirm" ? (item.done ? "kept" : "pending") : item.restored ? "restored" : "replaced"}`)} </Text> {item.display}
        </Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{t("record.step", { step: item.step + 1 })}</Text>
      </Pressable>
    );
  };

  return (
    <View ref={rootRef} collapsable={false} style={styles.reviewPage}>
      <View style={styles.row}>
        <View style={{ flex: 1, minWidth: 220 }}>
          <Text style={[styles.title, { color: colors.foreground }]}>{t("record.reviewTitle", { name: model.name })}</Text>
          <Text style={{ color: colors.statusWarning, fontSize: 12 }}>
            {t("record.redactionWarning")}
          </Text>
        </View>
        {btn(t("record.back"), () => setModel(null))}
        {/* Split button: the main part exports, the small arrow picks the format (YAML by default). */}
        <View style={{ flexDirection: "row" }}>
          <Pressable disabled={pending > 0} onPress={() => void doExport()} style={[styles.splitMain, { borderColor: colors.border, backgroundColor: colors.accent, opacity: pending > 0 ? 0.4 : 1 }]}>
            <Text style={{ color: colors.accentForeground }}>{canDownload ? t("record.download", { format }) : t("record.copy", { format: format.toUpperCase() })}</Text>
          </Pressable>
          <View ref={arrowRef} collapsable={false}>
            <Pressable accessibilityLabel={t("record.chooseFormat")} onPress={toggleFormatMenu} style={[styles.splitArrow, { borderColor: colors.border, backgroundColor: colors.accent }]}>
              <Text style={{ color: colors.accentForeground }}>▾</Text>
            </Pressable>
          </View>
        </View>
        {btn(t("record.replayNow"), () => void doReplay(), { disabled: pending > 0 })}
      </View>

      <View style={[styles.row, { marginTop: 8 }]}>
        {chip(t("record.toConfirm", { open: confirms.filter((i) => !i.done).length, total: confirms.length }), tab === "confirm", () => setTab("confirm"))}
        {chip(t("record.replaced", { count: replaced.length }), tab === "replaced", () => setTab("replaced"))}
        {btn(t("record.previous"), () => go(-1), { disabled: list.length === 0 })}
        <Text style={{ color: colors.foreground }}>{list.length === 0 ? t("record.none") : `${activeIndex < 0 ? "–" : activeIndex + 1} / ${list.length}`}</Text>
        {btn(t("record.next"), () => go(1), { disabled: list.length === 0 })}
        {active?.kind === "confirm" ? (
          <>
            {btn(t("record.redact"), () => resolve(active, "redact"), { primary: true })}
            {btn(t("record.keepAsIs"), () => resolve(active, "keep"))}
          </>
        ) : null}
        {btn(t("record.redactAll", { count: pending }), () => decideAll("redact"), { disabled: pending === 0, primary: pending > 0 && !active })}
        {btn(armKeepAll ? t("record.keepAllConfirm", { count: pending }) : t("record.keepAll", { count: pending }), () => decideAll("keep"), { disabled: pending === 0 })}
        {active?.kind === "replaced" ? btn(active.restored ? t("record.redactAgain") : t("record.restoreOriginal"), () => { restoreFinding(model, active.value, !active.restored); rerender(); }) : null}
      </View>
      {pending === 0 ? <Text style={{ color: colors.statusSuccess, marginTop: 4 }}>{t("record.nothingToConfirm")}</Text> : <Text style={{ color: colors.statusWarning, marginTop: 4 }}>{t("record.mustConfirm", { count: pending })}</Text>}

      <View style={[styles.row, { marginTop: 6 }]}>
        {LEGEND.map((l) => (
          <Text key={l.state} style={{ fontSize: 11, color: colors.foregroundMuted }}>
            <Text style={{ backgroundColor: highlight(l.state).bg, color: highlight(l.state).fg }}> {t(`record.state.${l.state}`)} </Text> {t(`record.legend.${l.state}`)}
          </Text>
        ))}
      </View>
      {active ? (
        <Text style={{ marginTop: 6, color: highlight("active").fg, backgroundColor: highlight("active").bg, padding: 6, borderRadius: 6 }}>
          {t("record.selected", { step: active.step + 1, kind: active.kind === "confirm" ? t("record.kindSecret") : t("record.kindReplaced"), display: active.display })}
        </Text>
      ) : null}

      <View style={{ flexDirection: wide ? "row" : "column", gap: 12, height: mainHeight, marginTop: 8 }}>
        <ScrollView ref={scroller} style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
          {views.map((step) => (
            <View key={step.index} onLayout={(e) => { stepY.current[step.index] = e.nativeEvent.layout.y; }} style={[styles.step, { borderColor: colors.border }]}>
              <Text style={{ color: colors.foregroundMuted }}>{t("record.step", { step: step.index + 1 })}</Text>
              {step.parts.map((p, pi) => {
                const isEditing = editing && editing.index === step.index && editing.field === p.field;
                const isActive = active && active.step === step.index && active.part === pi;
                return (
                  <View key={`${p.label}-${pi}`} onLayout={(e) => { partY.current[`${step.index}:${pi}`] = e.nativeEvent.layout.y; }} style={[styles.part, isActive ? { borderColor: highlight("active").bg, borderWidth: 2 } : { borderColor: "transparent" }]}>
                    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{p.label}</Text>
                    {isEditing ? (
                      <View style={styles.col}>
                        <TextInput multiline value={editing.text} onChangeText={(t) => setEditing((cur) => (cur ? { ...cur, text: t } : cur))} onSelectionChange={(e) => { const { start, end } = e.nativeEvent.selection; setEditing((cur) => (cur ? { ...cur, sel: cur.text.slice(start, end) } : cur)); }} style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface1 }]} />
                        <View style={styles.row}>
                          {btn(t("record.redactSelection"), () => { if (editing.sel) { redactSelection(model, editing.sel); rerender(); } }, { disabled: !editing.sel })}
                          {btn(t("settings.save"), () => { setModel(editStep(model, step.index, editing.field, editing.text)); setEditing(null); }, { primary: true })}
                          {btn(t("record.cancel"), () => setEditing(null))}
                        </View>
                      </View>
                    ) : (
                      <Text style={{ color: colors.foreground }}>
                        {p.segments.map((seg, i) =>
                          seg.finding ? (
                            <Text key={i} onPress={() => { restoreFinding(model, seg.finding!.original, !seg.finding!.restored); rerender(); }} style={{ backgroundColor: highlight(seg.finding.original === activeValue ? "active" : seg.finding.restored ? "restored" : "replaced").bg, color: highlight(seg.finding.original === activeValue ? "active" : seg.finding.restored ? "restored" : "replaced").fg, fontWeight: seg.finding.original === activeValue ? "700" : "400" }}>{seg.text}</Text>
                          ) : (
                            renderPlain(seg.text, model.redactor.suspicious(p.raw), String(i))
                          ),
                        )}
                      </Text>
                    )}
                    {p.field && !isEditing ? btn(t("record.edit"), () => setEditing({ index: step.index, field: p.field!, text: p.raw, sel: "" })) : null}
                  </View>
                );
              })}
            </View>
          ))}
        </ScrollView>

        <View style={[styles.side, wide ? { width: 300 } : { maxHeight: 170 }, { borderColor: colors.border }]}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, marginBottom: 4 }}>{tab === "confirm" ? t("record.itemsToConfirm") : t("record.replacedValues")}</Text>
          <ScrollView>{list.length === 0 ? <Text style={{ color: colors.foregroundMuted }}>{t("record.nothingHere")}</Text> : list.map(itemRow)}</ScrollView>
        </View>
      </View>

      {menuPos ? (
        <>
          <Pressable accessibilityLabel={t("record.closeFormatMenu")} onPress={() => setMenuPos(null)} style={[StyleSheet.absoluteFill, { zIndex: 999 }]} />
          <View style={[styles.menu, { left: menuPos.left, top: menuPos.top, width: MENU_WIDTH, borderColor: colors.border, backgroundColor: colors.surface1 }]}>
            {(["yaml", "json"] as const).map((f) => (
              <Pressable key={f} onPress={() => { setFormat(f); setMenuPos(null); }} style={[styles.menuItem, f === format ? { backgroundColor: colors.surface2 } : null]}>
                <Text style={{ color: colors.foreground }}>{f === format ? "✓ " : "   "}{f.toUpperCase()}</Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  page: { padding: 16, alignItems: "center" },
  setup: { width: "100%", maxWidth: 640, gap: 10 },
  reviewPage: { padding: 16, width: "100%", position: "relative" },
  title: { fontSize: 18, fontWeight: "600" },
  col: { gap: 8 },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center" },
  field: { gap: 4 },
  input: { borderWidth: 1, borderRadius: 6, padding: 8, fontSize: 13 },
  btn: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 },
  splitMain: { borderWidth: 1, borderTopLeftRadius: 6, borderBottomLeftRadius: 6, paddingHorizontal: 12, paddingVertical: 6 },
  splitArrow: { borderWidth: 1, borderLeftWidth: 0, borderTopRightRadius: 6, borderBottomRightRadius: 6, paddingHorizontal: 8, paddingVertical: 6 },
  menu: { position: "absolute", zIndex: 1000, elevation: 8, borderWidth: 1, borderRadius: 6, paddingVertical: 2, shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  menuItem: { paddingHorizontal: 12, paddingVertical: 8 },
  step: { borderWidth: 1, borderRadius: 8, padding: 8, marginBottom: 8, gap: 4 },
  part: { borderWidth: 1, borderRadius: 6, padding: 4, gap: 2 },
  side: { borderWidth: 1, borderRadius: 8, padding: 8 },
  itemRow: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, marginBottom: 4 },
});
