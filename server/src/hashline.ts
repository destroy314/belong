import { createHash } from 'node:crypto';

export type InsertHashlineEdit = {
  type: 'insert_before' | 'insert_after';
  hash: string;
  text: string;
};

export type ReplaceHashlineEdit = {
  type: 'replace';
  startHash: string;
  endHash: string;
  text: string;
};

export type DeleteHashlineEdit = {
  type: 'delete';
  startHash: string;
  endHash: string;
};

export type HashlineEdit =
  | InsertHashlineEdit
  | ReplaceHashlineEdit
  | DeleteHashlineEdit;

export interface HashlineLine {
  hash: string;
  text: string;
}

export interface HashlineView {
  version: string;
  text: string;
  lines: HashlineLine[];
  newline: '\n' | '\r\n';
  finalNewline: boolean;
}

export interface HashlineDiff {
  addedLines: number;
  removedLines: number;
  summary: string;
}

export interface AppliedHashlineEdits {
  content: string;
  version: string;
  view: HashlineView;
  diff: HashlineDiff;
}

export class InventoryConflictError extends Error {
  readonly code = 'INVENTORY_VERSION_CONFLICT';

  constructor(
    readonly expectedVersion: string,
    readonly currentVersion: string,
  ) {
    super(
      `Inventory version conflict: expected ${expectedVersion}, current ${currentVersion}`,
    );
    this.name = 'InventoryConflictError';
  }
}

export class HashlineValidationError extends Error {
  readonly code = 'HASHLINE_VALIDATION_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'HashlineValidationError';
  }
}

interface LineDocument {
  lines: string[];
  newline: '\n' | '\r\n';
  finalNewline: boolean;
}

interface NormalizedInsert {
  kind: 'insert';
  position: number;
  lines: string[];
}

interface NormalizedRange {
  kind: 'range';
  start: number;
  end: number;
  lines: string[];
}

type NormalizedEdit = NormalizedInsert | NormalizedRange;

export function inventoryVersion(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Builds a temporary, deterministic view. The line index participates in the
 * hash so equal lines still receive distinct anchors within the same view.
 */
export function buildHashlineView(content: string): HashlineView {
  const document = splitLineDocument(content);
  const used = new Set<string>();
  const lines = document.lines.map((line, index) => ({
    hash: uniqueShortHash(index, line, used),
    text: line,
  }));

  return {
    version: inventoryVersion(content),
    text: lines.map((line) => `${line.hash}|${line.text}`).join('\n'),
    lines,
    newline: document.newline,
    finalNewline: document.finalNewline,
  };
}

/**
 * Validates every operation against one immutable snapshot, rejects ambiguous
 * overlapping edits, then applies the batch from bottom to top.
 */
export function applyHashlineEdits(
  content: string,
  expectedVersion: string,
  edits: readonly HashlineEdit[],
): AppliedHashlineEdits {
  const currentView = buildHashlineView(content);
  if (!expectedVersion || expectedVersion !== currentView.version) {
    throw new InventoryConflictError(expectedVersion, currentView.version);
  }
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new HashlineValidationError('At least one edit is required');
  }

  const document = splitLineDocument(content);
  const hashIndexes = new Map(
    currentView.lines.map((line, index) => [line.hash, index]),
  );
  const normalized = edits.map((edit, index) =>
    normalizeEdit(edit, index, hashIndexes),
  );
  assertNoOverlaps(normalized);

  let addedLines = 0;
  let removedLines = 0;
  const resultLines = [...document.lines];
  const sorted = [...normalized].sort((left, right) => {
    const leftIndex = left.kind === 'insert' ? left.position : left.start;
    const rightIndex = right.kind === 'insert' ? right.position : right.start;
    if (leftIndex !== rightIndex) return rightIndex - leftIndex;
    // A range at the same boundary must be applied before an insertion that
    // belongs immediately before it.
    return left.kind === 'range' ? -1 : 1;
  });

  for (const edit of sorted) {
    if (edit.kind === 'insert') {
      resultLines.splice(edit.position, 0, ...edit.lines);
      addedLines += edit.lines.length;
      continue;
    }

    const removed = edit.end - edit.start + 1;
    resultLines.splice(edit.start, removed, ...edit.lines);
    addedLines += edit.lines.length;
    removedLines += removed;
  }

  const nextContent = joinLineDocument({
    lines: resultLines,
    newline: document.newline,
    finalNewline: document.finalNewline,
  });
  const view = buildHashlineView(nextContent);
  return {
    content: nextContent,
    version: view.version,
    view,
    diff: {
      addedLines,
      removedLines,
      summary: `+${addedLines} -${removedLines}`,
    },
  };
}

function normalizeEdit(
  edit: HashlineEdit,
  editIndex: number,
  hashIndexes: ReadonlyMap<string, number>,
): NormalizedEdit {
  if (!edit || typeof edit !== 'object' || typeof edit.type !== 'string') {
    throw new HashlineValidationError(`Edit ${editIndex} is invalid`);
  }

  if (edit.type === 'insert_before' || edit.type === 'insert_after') {
    const anchor = requireHash(edit.hash, `edit ${editIndex} hash`, hashIndexes);
    return {
      kind: 'insert',
      position: edit.type === 'insert_before' ? anchor : anchor + 1,
      lines: splitEditText(edit.text, editIndex),
    };
  }

  if (edit.type === 'replace' || edit.type === 'delete') {
    const start = requireHash(
      edit.startHash,
      `edit ${editIndex} startHash`,
      hashIndexes,
    );
    const end = requireHash(
      edit.endHash,
      `edit ${editIndex} endHash`,
      hashIndexes,
    );
    if (start > end) {
      throw new HashlineValidationError(
        `Edit ${editIndex} has startHash after endHash`,
      );
    }
    return {
      kind: 'range',
      start,
      end,
      lines: edit.type === 'replace' ? splitEditText(edit.text, editIndex) : [],
    };
  }

  throw new HashlineValidationError(
    `Edit ${editIndex} has unsupported type ${(edit as { type: string }).type}`,
  );
}

function splitEditText(text: string, editIndex: number): string[] {
  if (typeof text !== 'string') {
    throw new HashlineValidationError(`Edit ${editIndex} text must be a string`);
  }
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function requireHash(
  hash: string,
  label: string,
  hashIndexes: ReadonlyMap<string, number>,
): number {
  if (typeof hash !== 'string' || !hashIndexes.has(hash)) {
    throw new HashlineValidationError(`${label} is stale or unknown`);
  }
  return hashIndexes.get(hash)!;
}

function assertNoOverlaps(edits: readonly NormalizedEdit[]): void {
  for (let leftIndex = 0; leftIndex < edits.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < edits.length; rightIndex += 1) {
      const left = edits[leftIndex]!;
      const right = edits[rightIndex]!;
      if (overlaps(left, right)) {
        throw new HashlineValidationError(
          `Edits ${leftIndex} and ${rightIndex} overlap`,
        );
      }
    }
  }
}

function overlaps(left: NormalizedEdit, right: NormalizedEdit): boolean {
  if (left.kind === 'insert' && right.kind === 'insert') {
    return left.position === right.position;
  }
  if (left.kind === 'range' && right.kind === 'range') {
    return left.start <= right.end && right.start <= left.end;
  }

  const insertion = left.kind === 'insert' ? left : right as NormalizedInsert;
  const range = left.kind === 'range' ? left : right as NormalizedRange;
  // Positions are gaps between lines. The outer boundaries are unambiguous;
  // positions strictly inside a replaced/deleted range are not.
  return insertion.position > range.start && insertion.position <= range.end;
}

function splitLineDocument(content: string): LineDocument {
  const newline: '\n' | '\r\n' = content.includes('\r\n') ? '\r\n' : '\n';
  const finalNewline = content.endsWith('\n');
  let body = finalNewline
    ? content.slice(0, content.length - newline.length)
    : content;
  body = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return {
    lines: body === '' ? [] : body.split('\n'),
    newline,
    finalNewline,
  };
}

function joinLineDocument(document: LineDocument): string {
  const body = document.lines.join(document.newline);
  if (!document.finalNewline) return body;
  return `${body}${document.newline}`;
}

function uniqueShortHash(
  index: number,
  line: string,
  used: Set<string>,
): string {
  const digest = createHash('sha256')
    .update(`${index}\0${line}`, 'utf8')
    .digest('hex');
  for (let length = 8; length <= digest.length; length += 2) {
    const candidate = digest.slice(0, length);
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  // The index is part of the digest input, so reaching this path would require
  // a complete SHA-256 collision. Keep the failure explicit rather than emit an
  // ambiguous anchor.
  throw new HashlineValidationError('Unable to create unique line hash');
}
