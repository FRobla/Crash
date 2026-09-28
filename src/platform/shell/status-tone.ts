export type StatusTone = "neutral" | "ok" | "warn" | "danger";

export const STATUS_TONE_TEXT_CLASS: Record<StatusTone, string> = {
  neutral: "text-fg",
  ok: "text-accent",
  warn: "text-warn",
  danger: "text-danger",
};
