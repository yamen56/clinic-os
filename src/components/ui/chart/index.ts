/*
  The workspace's charts. One series each, in the clinic's chart colour
  (`--color-chart`, tinted per clinic by `.clinic-chart-vars`), on quiet
  hairlines, with a fixed readout row instead of a floating tooltip.

  - AreaTrend: money or counts flowing over time (falls back to columns under four points).
  - ColumnChart: counts, or money that arrives in lumps; `compact` for a row of small multiples.
  - RankedRow / RowBar: a breakdown, largest first, on one shared scale.
*/
export { AreaTrend, ColumnChart, type ChartPoint } from "./trend";
export { RankedRow, RowBar } from "./ranked";
export { niceTicks, niceStep, formatValue } from "./scale";
