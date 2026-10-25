import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useT } from "./i18n";
import { getStatusRpc, readRecordRpc, scriptedSettings } from "../shared/rpc";

const ALIGNMENTS = ["warn", "strict", "ignore"] as const;

export const ScriptedSettingsScreen: React.FC<PluginSurfaceProps> = ({ theme }) => {
  const t = useT();
  const settings = useSettings(scriptedSettings);
  const status = useRpc(getStatusRpc);
  const readRecord = useRpc(readRecordRpc);
  const { colors } = theme;
  const [draft, setDraft] = useState<{ scripts: string; scriptFile: string; recordFile: string; alignment: (typeof ALIGNMENTS)[number] } | null>(null);
  // The revision the draft was loaded from: saving against it makes the host reject a stale overwrite.
  const [baseRevision, setBaseRevision] = useState<string | null>(null);
  const [info, setInfo] = useState<{ scenarios: string[]; error: string | null } | null>(null);
  const [lines, setLines] = useState<string[]>([]);

  const refresh = useCallback(() => {
    void status({}).then(setInfo).catch(() => setInfo(null));
    void readRecord({ limit: 50 }).then((r) => setLines(r.lines)).catch(() => setLines([]));
  }, [status, readRecord]);

  useEffect(() => {
    if (settings.status === "ready" && !draft) {
      setDraft({ ...settings.values });
      setBaseRevision(settings.revision);
    }
  }, [settings, draft]);
  useEffect(refresh, [refresh, settings.status === "ready" ? settings.revision : ""]);

  if (settings.status === "loading" || !draft) {
    return settings.status === "error" || settings.status === "invalid" ? (
      <View style={styles.container}>
        <Text style={{ color: colors.statusDanger }}>{t("settings.loadFailed", { error: settings.error ?? "" })}</Text>
        <Pressable onPress={() => void settings.reset()}>
          <Text style={{ color: colors.accent }}>{t("settings.resetDefaults")}</Text>
        </Pressable>
      </View>
    ) : (
      <View style={styles.container}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const input = [styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface1 }];
  const label = [styles.label, { color: colors.foreground }];
  const hint = [styles.hint, { color: colors.foregroundMuted }];
  const changedElsewhere = settings.status === "ready" && baseRevision !== null && settings.revision !== baseRevision;
  const reloadDraft = () => {
    if (settings.status !== "ready") return;
    setDraft({ ...settings.values });
    setBaseRevision(settings.revision);
  };
  const save = () => {
    if (settings.status !== "ready" || baseRevision === null) return;
    void settings.save(draft, baseRevision).then((ok) => {
      if (ok) {
        // the saved document is now what the host shows; adopt its revision once it arrives
        setBaseRevision(null);
        setDraft(null);
      }
      refresh();
    });
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={[styles.title, { color: colors.foreground }]}>{t("settings.title")}</Text>
      <Text style={hint}>{t("settings.intro")}</Text>

      <Text style={label}>{t("settings.script")}</Text>
      <TextInput multiline style={[...input, styles.script]} value={draft.scripts} onChangeText={(v) => setDraft({ ...draft, scripts: v })} placeholder={"scenarios:\n  hello:\n    - text: Hi"} autoCapitalize="none" autoCorrect={false} />
      <Text style={hint}>{t("settings.scriptHint")}</Text>

      <Text style={label}>{t("settings.scriptFile")}</Text>
      <TextInput style={input} value={draft.scriptFile} onChangeText={(v) => setDraft({ ...draft, scriptFile: v })} autoCapitalize="none" autoCorrect={false} />

      <Text style={label}>{t("settings.recordFile")}</Text>
      <TextInput style={input} value={draft.recordFile} onChangeText={(v) => setDraft({ ...draft, recordFile: v })} autoCapitalize="none" autoCorrect={false} />

      <Text style={label}>{t("settings.alignment")}</Text>
      <View style={styles.row}>
        {ALIGNMENTS.map((a) => (
          <Pressable key={a} onPress={() => setDraft({ ...draft, alignment: a })} style={[styles.chip, { borderColor: colors.border, backgroundColor: draft.alignment === a ? colors.accent : colors.surface2 }]}>
            <Text style={{ color: draft.alignment === a ? colors.accentForeground : colors.foreground }}>{t(`settings.alignmentOption.${a}`)}</Text>
          </Pressable>
        ))}
      </View>

      {changedElsewhere ? (
        <View style={styles.row}>
          <Text style={{ color: colors.statusWarning, flex: 1 }}>{t("settings.changedElsewhere")}</Text>
          <Pressable onPress={reloadDraft}>
            <Text style={{ color: colors.accent }}>{t("settings.reload")}</Text>
          </Pressable>
        </View>
      ) : null}
      <Pressable onPress={save} disabled={settings.saving} style={[styles.button, { backgroundColor: colors.accent }]}>
        <Text style={{ color: colors.accentForeground }}>{settings.saving ? t("settings.saving") : t("settings.save")}</Text>
      </Pressable>
      {settings.saveError ? <Text style={{ color: colors.statusDanger }}>{settings.saveError}</Text> : null}

      {info?.error ? <Text style={{ color: colors.statusDanger }}>{t("settings.scriptProblem", { error: info.error })}</Text> : null}
      <Text style={hint}>{t("settings.scenarios", { list: info ? info.scenarios.join(", ") : "…" })}</Text>

      <View style={styles.row}>
        <Text style={label}>{t("settings.received")}</Text>
        <Pressable onPress={refresh}>
          <Text style={{ color: colors.accent }}>{t("settings.refresh")}</Text>
        </Pressable>
      </View>
      {lines.length === 0 ? <Text style={hint}>{t("settings.nothingRecorded")}</Text> : null}
      {lines.map((l, i) => (
        <Text key={i} style={[styles.mono, { color: colors.foregroundMuted }]}>{l}</Text>
      ))}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { padding: 16, gap: 8 },
  title: { fontSize: 18, fontWeight: "600" },
  label: { fontSize: 14, fontWeight: "500", marginTop: 8 },
  hint: { fontSize: 12 },
  input: { borderWidth: 1, borderRadius: 6, padding: 8, fontSize: 13 },
  script: { minHeight: 140, textAlignVertical: "top", fontFamily: "monospace" },
  row: { flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "space-between" },
  chip: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 },
  button: { borderRadius: 6, paddingVertical: 10, alignItems: "center", marginTop: 8 },
  mono: { fontFamily: "monospace", fontSize: 11 },
});
