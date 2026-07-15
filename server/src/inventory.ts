import { randomBytes } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  applyHashlineEdits,
  buildHashlineView,
  HashlineValidationError,
  InventoryConflictError,
  type HashlineDiff,
  type HashlineEdit,
  type HashlineView,
} from './hashline.js';

export { HashlineValidationError, InventoryConflictError } from './hashline.js';

export interface InventoryLocation {
  title: string;
  level: number;
  path: string[];
  description: string;
  items: string[];
  children: InventoryLocation[];
  line: number;
}

export interface ParsedInventory {
  preamble: string;
  locations: InventoryLocation[];
}

export interface InventorySnapshot {
  content: string;
  version: string;
  view: HashlineView;
  document: ParsedInventory;
}

export interface InventoryMutation extends InventorySnapshot {
  diff: HashlineDiff;
}

interface MutableLocation extends Omit<InventoryLocation, 'children'> {
  children: MutableLocation[];
  bodyLines: string[];
}

const fileLocks = new Map<string, Promise<void>>();
const DEFAULT_INVENTORY = '# 家\n';

/** Parse the relaxed heading/list format used by inventory.md. */
export function parseInventoryMarkdown(markdown: string): ParsedInventory {
  const lines = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const roots: MutableLocation[] = [];
  const stack: MutableLocation[] = [];
  const preambleLines: string[] = [];
  let current: MutableLocation | undefined;
  let fence: '`' | '~' | undefined;

  lines.forEach((line, lineIndex) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]! as '`' | '~';
      if (!fence) fence = marker;
      else if (fence === marker) fence = undefined;
      if (current) current.bodyLines.push(line);
      else preambleLines.push(line);
      return;
    }

    const heading = fence ? undefined : parseHeading(line);
    if (heading) {
      while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) {
        stack.pop();
      }
      const parent = stack[stack.length - 1];
      const location: MutableLocation = {
        title: heading.title,
        level: heading.level,
        path: parent ? [...parent.path, heading.title] : [heading.title],
        description: '',
        items: [],
        children: [],
        line: lineIndex + 1,
        bodyLines: [],
      };
      if (parent) parent.children.push(location);
      else roots.push(location);
      stack.push(location);
      current = location;
      return;
    }

    if (current) current.bodyLines.push(line);
    else preambleLines.push(line);
  });

  const locations = roots.map(finalizeLocation);
  return {
    preamble: trimBlankLines(preambleLines).join('\n'),
    locations,
  };
}

export class InventoryStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  inventoryPath(familyId: string): string {
    assertFamilyId(familyId);
    return path.join(this.rootDir, familyId, 'inventory.md');
  }

  async load(familyId: string): Promise<InventorySnapshot> {
    const filePath = this.inventoryPath(familyId);
    await ensureInventoryFile(filePath);
    const content = await readFile(filePath, 'utf8');
    return snapshot(content);
  }

  async apply(
    familyId: string,
    expectedVersion: string,
    edits: readonly HashlineEdit[],
  ): Promise<InventoryMutation> {
    const filePath = this.inventoryPath(familyId);
    return withFileLock(filePath, async () => {
      await ensureInventoryFile(filePath);
      const currentContent = await readFile(filePath, 'utf8');
      const result = applyHashlineEdits(currentContent, expectedVersion, edits);
      await atomicWrite(filePath, result.content);
      return {
        content: result.content,
        version: result.version,
        view: result.view,
        document: parseInventoryMarkdown(result.content),
        diff: result.diff,
      };
    });
  }

  /** Remove all inventory data for a deleted family. */
  async deleteFamily(familyId: string): Promise<void> {
    assertFamilyId(familyId);
    await rm(path.join(this.rootDir, familyId), { recursive: true, force: true });
  }
}

function snapshot(content: string): InventorySnapshot {
  const view = buildHashlineView(content);
  return {
    content,
    version: view.version,
    view,
    document: parseInventoryMarkdown(content),
  };
}

function parseHeading(line: string): { level: number; title: string } | undefined {
  const match = line.match(/^(#{1,6})[ \t]+(.+?)[ \t]*$/);
  if (!match) return undefined;
  const title = match[2]!.replace(/[ \t]+#+[ \t]*$/, '').trim();
  if (!title) return undefined;
  return { level: match[1]!.length, title };
}

function finalizeLocation(location: MutableLocation): InventoryLocation {
  const descriptionLines: string[] = [];
  const items: string[] = [];
  let fence: '`' | '~' | undefined;

  for (const line of location.bodyLines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]! as '`' | '~';
      if (!fence) fence = marker;
      else if (fence === marker) fence = undefined;
      descriptionLines.push(line);
      continue;
    }
    const item = fence ? undefined : line.match(/^\s*[-+*][ \t]+(.+?)\s*$/);
    if (item) items.push(item[1]!);
    else descriptionLines.push(line);
  }

  return {
    title: location.title,
    level: location.level,
    path: location.path,
    description: trimBlankLines(descriptionLines).join('\n'),
    items,
    children: location.children.map(finalizeLocation),
    line: location.line,
  };
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === '') start += 1;
  while (end > start && lines[end - 1]!.trim() === '') end -= 1;
  return lines.slice(start, end);
}

function assertFamilyId(familyId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(familyId)) {
    throw new Error('Invalid family id');
  }
}

async function ensureInventoryFile(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, DEFAULT_INVENTORY, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function withFileLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const ticket = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => ticket);
  fileLocks.set(key, tail);

  await previous;
  try {
    return await task();
  } finally {
    release();
    if (fileLocks.get(key) === tail) fileLocks.delete(key);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
