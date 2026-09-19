/**
 * Report export (spec section 16: "Provide: Excel, CSV").
 *
 * An export holds everything the report screen shows — the headline figures,
 * every breakdown, the trend and every table — so a downloaded file never
 * disagrees with the page it came from. Excel gets a Summary sheet and one
 * sheet per table; CSV, which has no sheets, puts them one after another.
 *
 * ## Formula injection
 *
 * The important thing in this file. A CSV cell beginning `=`, `+`, `-`, `@`,
 * tab or carriage return is interpreted by Excel and Google Sheets as a
 * **formula**, not text. So a customer named `=cmd|'/c calc'!A1`, or a
 * complaint category pasted from anywhere, becomes executable the moment
 * someone opens the export.
 *
 * Text in these reports is user input: names, cities, complaint categories.
 * So each text cell is prefixed with a single quote when it starts with one of
 * those characters, which spreadsheets read as "treat as text". Numbers are
 * written as numbers — they cannot carry a formula, and a count stored as text
 * cannot be summed or sorted.
 *
 * This applies to the Excel path too, not just CSV — the vulnerability is in
 * the spreadsheet application, not the file format.
 */
import ExcelJS from 'exceljs';
import { dayKey, formatDay, periodLabel } from './report.labels.js';
import type {
  Breakdown,
  ReportColumn,
  ReportTable,
  SummaryItem,
  Trend,
  ValueFormat,
} from './report.types.js';

export interface ExportInput {
  title: string;
  /** Lines under the title: when, by whom, and the filters in force. */
  meta: Array<{ label: string; value: string }>;
  summary: SummaryItem[];
  breakdowns: Breakdown[];
  trend?: Trend;
  tables: ReportTable[];
}

/** Characters a spreadsheet treats as the start of a formula. */
const FORMULA_STARTERS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Renders a value as text, neutralising anything a spreadsheet would execute.
 */
export function safeCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const text = String(value);

  /* A leading formula character makes the cell executable on open. The
     apostrophe is the spreadsheet convention for "this is literally text". */
  if (FORMULA_STARTERS.some((char) => text.startsWith(char))) {
    return `'${text}`;
  }

  return text;
}

/** The unit belongs in the heading, so the cell below can stay a number. */
function withUnit(header: string, format: ValueFormat): string {
  if (format === 'percent') return `${header} (%)`;
  if (format === 'hours') return `${header} (hours)`;
  return header;
}

/** A cell value: numbers stay numbers, dates become readable, text is made safe. */
function cellValue(value: unknown, format: ValueFormat): string | number {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') return value;
  if (format === 'date') {
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? safeCell(value) : formatDay(date);
  }
  return safeCell(value);
}

const TREND_HEADERS: Record<Trend['unit'], string> = {
  day: 'Date',
  week: 'Week starting',
  month: 'Month',
  year: 'Year',
};

const trendHeader = (trend: Trend) => TREND_HEADERS[trend.unit];

/** Trend labels carry no year on daily and weekly points; the file spells the date out. */
const trendLabel = (trend: Trend, key: string) =>
  trend.unit === 'day' || trend.unit === 'week'
    ? formatDay(new Date(`${key}T12:00:00Z`))
    : periodLabel(key, trend.unit);

/* ---- CSV ------------------------------------------------------------------ */

/** Quotes and escapes a value for CSV. */
function csvField(value: unknown): string {
  const text = typeof value === 'number' ? String(value) : safeCell(value);

  /* Quote whenever the value could otherwise break the row structure. */
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

const csvRow = (cells: unknown[]) => cells.map(csvField).join(',');

export function toCsv(input: ExportInput): string {
  const lines: string[] = [];

  /* A saved export should say what it is and what was filtered, or it is just
     an anonymous grid of numbers three weeks later. */
  lines.push(csvField(input.title));
  for (const { label, value } of input.meta) lines.push(csvRow([label, value]));

  if (input.summary.length > 0) {
    lines.push('', 'Summary');
    for (const item of input.summary) {
      lines.push(csvRow([withUnit(item.label, item.format), item.value ?? '']));
    }
  }

  for (const breakdown of input.breakdowns) {
    lines.push('', csvField(breakdown.title), csvRow([breakdown.labelHeader, breakdown.valueHeader]));
    for (const item of breakdown.items) lines.push(csvRow([item.label, item.value]));
  }

  if (input.trend && input.trend.points.length > 0) {
    const trend = input.trend;
    lines.push('', csvField(trend.title), csvRow([trendHeader(trend), trend.valueHeader]));
    for (const point of trend.points) lines.push(csvRow([trendLabel(trend, point.key), point.value]));
  }

  for (const table of input.tables) {
    lines.push('', csvField(table.title));
    lines.push(csvRow(table.columns.map((column) => withUnit(column.header, column.format))));
    for (const row of table.rows) {
      lines.push(csvRow(table.columns.map((column) => cellValue(row[column.key], column.format))));
    }
  }

  /* CRLF: Excel on Windows is the overwhelmingly likely destination. */
  return lines.join('\r\n');
}

/* ---- Excel ---------------------------------------------------------------- */

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFEFEFEF' },
};

/** Sheet names cannot exceed 31 characters, repeat, or contain \ / ? * [ ] : */
function sheetName(title: string, taken: Set<string>): string {
  const base = title.replace(/[\\/?*[\]:]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Sheet';
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
    const suffix = ` (${n})`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  taken.add(name.toLowerCase());
  return name;
}

function numberFormat(format: ValueFormat): string | undefined {
  if (format === 'hours' || format === 'decimal') return '0.0';
  if (format === 'number' || format === 'percent') return '0';
  return undefined;
}

export async function toXlsx(input: ExportInput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Cooler CRM';
  workbook.created = new Date();
  const taken = new Set<string>();

  /* ---- Summary sheet: what this is, the headline figures, the breakdowns. */
  const summary = workbook.addWorksheet(sheetName('Summary', taken));
  summary.getColumn(1).width = 34;
  summary.getColumn(2).width = 40;

  summary.addRow([input.title]).font = { bold: true, size: 14 };
  for (const { label, value } of input.meta) summary.addRow([safeCell(label), safeCell(value)]);

  const section = (title: string, headers: [string, string]) => {
    summary.addRow([]);
    summary.addRow([safeCell(title)]).font = { bold: true };
    const header = summary.addRow(headers.map(safeCell));
    header.font = { bold: true };
    header.eachCell((cell) => {
      cell.fill = HEADER_FILL;
    });
  };

  if (input.summary.length > 0) {
    section('Summary', ['Figure', 'Value']);
    for (const item of input.summary) {
      summary.addRow([withUnit(item.label, item.format), item.value ?? '']);
    }
  }

  for (const breakdown of input.breakdowns) {
    section(breakdown.title, [breakdown.labelHeader, breakdown.valueHeader]);
    for (const item of breakdown.items) summary.addRow([safeCell(item.label), item.value]);
  }

  if (input.trend && input.trend.points.length > 0) {
    const trend = input.trend;
    section(trend.title, [trendHeader(trend), trend.valueHeader]);
    for (const point of trend.points) summary.addRow([trendLabel(trend, point.key), point.value]);
  }

  /* ---- One sheet per table, header frozen and filterable. */
  for (const table of input.tables) {
    const sheet = workbook.addWorksheet(sheetName(table.title, taken));

    const header = sheet.addRow(table.columns.map((column: ReportColumn) => withUnit(column.header, column.format)));
    header.font = { bold: true };
    header.eachCell((cell) => {
      cell.fill = HEADER_FILL;
    });

    for (const row of table.rows) {
      sheet.addRow(table.columns.map((column) => cellValue(row[column.key], column.format)));
    }

    table.columns.forEach((column, index) => {
      const sheetColumn = sheet.getColumn(index + 1);
      sheetColumn.width = column.width ?? 18;
      const numFmt = numberFormat(column.format);
      if (numFmt) sheetColumn.numFmt = numFmt;
    });

    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    if (table.columns.length > 0) {
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: table.columns.length } };
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** A filename that is safe on every platform and says what it contains. */
export function exportFilename(title: string, extension: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

  /* The company's date, not UTC's: a file made at 1 a.m. is today's. */
  return `${slug}-${dayKey(new Date())}.${extension}`;
}
