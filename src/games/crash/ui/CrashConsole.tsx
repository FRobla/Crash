import { Panel } from "@/platform/shell/Panel";
import { StatusItem } from "@/platform/shell/StatusItem";

const GRID_ROWS = 4;
const GRID_COLUMNS = 8;

/**
 * Round view. It is static until the round engine and its projection exist:
 * it must never show a multiplier or round data that did not come from an authoritative source.
 */
export function CrashConsole() {
  return (
    <Panel
      titleId="crash-console-title"
      title="Crash"
      meta={
        <>
          <StatusItem label="round" value="#—" />
          <StatusItem label="commit" value="—" />
          <StatusItem label="state" value="idle" />
        </>
      }
    >
      <div className="relative h-64 sm:h-80">
        <MultiplierGrid />
        <div className="relative flex h-full flex-col items-center justify-center gap-2 px-4">
          <p className="text-5xl font-semibold tabular-nums text-muted sm:text-7xl">
            <span aria-hidden="true">—.——x</span>
            <span className="sr-only">No multiplier: no round in progress</span>
          </p>
          <p className="text-sm text-muted">idle · no round in progress</p>
        </div>
      </div>
    </Panel>
  );
}

function MultiplierGrid() {
  return (
    <svg
      aria-hidden="true"
      className="absolute inset-0 h-full w-full text-border"
      viewBox="0 0 800 320"
      preserveAspectRatio="none"
    >
      {Array.from({ length: GRID_ROWS - 1 }, (_, index) => {
        const y = ((index + 1) * 320) / GRID_ROWS;
        return (
          <line
            key={`row-${y}`}
            x1="0"
            x2="800"
            y1={y}
            y2={y}
            stroke="currentColor"
            strokeDasharray="4 6"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      {Array.from({ length: GRID_COLUMNS - 1 }, (_, index) => {
        const x = ((index + 1) * 800) / GRID_COLUMNS;
        return (
          <line
            key={`column-${x}`}
            x1={x}
            x2={x}
            y1="0"
            y2="320"
            stroke="currentColor"
            strokeDasharray="4 6"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      {/* Baseline at 1.00x, where every round starts. */}
      <line
        x1="0"
        x2="800"
        y1="319"
        y2="319"
        className="text-accent/40"
        stroke="currentColor"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
