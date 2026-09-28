import { STATUS_TONE_TEXT_CLASS, type StatusTone } from "./status-tone";

interface StatusItemProps {
  label: string;
  value: string;
  tone?: StatusTone;
}

/** A `label: value` pair. The state is always written out, never conveyed by color alone. */
export function StatusItem({ label, value, tone = "neutral" }: StatusItemProps) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="text-muted">{label}:</span>
      <span className={STATUS_TONE_TEXT_CLASS[tone]}>
        {tone !== "neutral" && (
          <span aria-hidden="true" className="mr-1">
            ●
          </span>
        )}
        {value}
      </span>
    </span>
  );
}
