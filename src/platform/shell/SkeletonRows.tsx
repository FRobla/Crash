/** Placeholder rows while data loads; the caller keeps a text status for assistive technology. */
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="h-4 animate-pulse rounded bg-surface-raised" style={{ width: `${95 - ((index * 13) % 30)}%` }} />
      ))}
    </div>
  );
}
