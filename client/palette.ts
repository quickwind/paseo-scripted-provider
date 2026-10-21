/** Fixed colors for the review screen, so a color always means the same thing whatever the app theme is. */
export type HighlightState = "active" | "pending" | "replaced" | "kept" | "restored";

const COLORS: Record<HighlightState, { bg: string; fg: string }> = {
  active: { bg: "#FB923C", fg: "#111827" }, // orange: the item you are looking at
  pending: { bg: "#FEF08A", fg: "#713F12" }, // yellow: looks like a secret, needs your decision
  replaced: { bg: "#BBF7D0", fg: "#14532D" }, // green: replaced automatically
  kept: { bg: "#E5E7EB", fg: "#374151" }, // gray: you chose to keep it
  restored: { bg: "#FECACA", fg: "#7F1D1D" }, // red: original text restored, it will be exported as is
};

export const highlight = (state: HighlightState) => COLORS[state];

export const LEGEND: { state: HighlightState; text: string }[] = [
  { state: "active", text: "the item you selected" },
  { state: "pending", text: "looks like a secret — Redact or Keep it" },
  { state: "replaced", text: "replaced automatically (tap to restore the original)" },
  { state: "kept", text: "you chose to keep it as is" },
  { state: "restored", text: "original restored — it will be exported" },
];
