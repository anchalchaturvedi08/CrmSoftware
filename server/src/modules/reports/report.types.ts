/**
 * The shape every report returns (spec section 16).
 *
 * One shape for all five reports, so the screen can render any of them
 * without knowing which it has, and the exporter writes exactly what the
 * screen shows. When the download and the page are built from the same
 * object, they cannot disagree.
 */

/**
 * How a value should be read.
 *
 * Values stay numbers — a percentage is `45`, not `"45%"` — so a spreadsheet
 * can sort and sum them. The format tells the screen how to print one and the
 * exporter what unit to put in the column heading.
 */
export type ValueFormat = 'number' | 'decimal' | 'percent' | 'hours' | 'text' | 'date';

/** A headline figure, shown as a tile above the report. */
export interface SummaryItem {
  key: string;
  label: string;
  /**
   * Null when there is nothing to measure. With no closed complaints there is
   * no average time to close, and printing 0 would claim instant repairs.
   */
  value: number | null;
  /* 'decimal' keeps one place, for figures like an average rating. */
  format: 'number' | 'decimal' | 'percent' | 'hours';
}

export interface BreakdownItem {
  /** The stored value, e.g. `IN_PROGRESS`, for screens that style by it. */
  key: string;
  label: string;
  value: number;
}

/** Counts across categories — drawn as bars, exported as two columns. */
export interface Breakdown {
  key: string;
  title: string;
  /** Column headings when the breakdown is written to a spreadsheet. */
  labelHeader: string;
  valueHeader: string;
  items: BreakdownItem[];
}

export interface TrendPoint {
  /** `2026-09-16` (a day, or the Monday a week starts), `2026-09` or `2026`. */
  key: string;
  label: string;
  value: number;
}

/** Counts over time, with the empty periods filled in. */
export interface Trend {
  title: string;
  unit: 'day' | 'week' | 'month' | 'year';
  valueHeader: string;
  points: TrendPoint[];
}

export interface ReportColumn {
  key: string;
  header: string;
  format: ValueFormat;
  /** Spreadsheet column width, in characters. */
  width?: number;
}

export type ReportRow = Record<string, string | number | null | undefined>;

export interface ReportTable {
  key: string;
  title: string;
  columns: ReportColumn[];
  /**
   * Rows may carry keys that are not columns — a complaint id behind a
   * complaint number, say — for the screen to link with. Exports write only
   * the columns.
   */
  rows: ReportRow[];
  /** How many rows exist, before any limit. */
  total: number;
  truncated?: boolean;
}

export interface ReportResult {
  title: string;
  /** What the date range counts, in plain words. */
  dateBasis: string;
  summary: SummaryItem[];
  breakdowns: Breakdown[];
  trend?: Trend;
  tables: ReportTable[];
}
