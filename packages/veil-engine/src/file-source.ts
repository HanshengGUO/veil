import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { EngineConfigurationError } from "./errors.ts";
import {
  createSourceManifest,
  type SourceManifest,
  type SourceManifestFile,
} from "./source-manifest.ts";

const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;
const UNSUPPORTED_GLOB_PATTERN = /[[\]{}]/;

export interface CapturedFileSource {
  /** Canonical paths are private backend input and must never enter result serialization. */
  readonly paths: readonly string[];
  readonly manifest: SourceManifest;
}

export interface StableFileSourceResult<T> {
  readonly source: CapturedFileSource;
  readonly value: T;
}

interface ResolvedFile {
  readonly logicalName: string;
  readonly path: string;
}

interface ParsedLocator {
  readonly value: string;
  readonly segments: readonly string[];
  readonly hasPattern: boolean;
}

export async function captureBoundFileSource(
  rootInput: string | undefined,
  locatorInput: string,
): Promise<CapturedFileSource> {
  const locator = parseLocator(locatorInput);
  try {
    const canonicalRoot = await resolveRoot(rootInput);
    const files = locator.hasPattern
      ? await resolveGlobFiles(canonicalRoot, locator)
      : [await resolveCandidate(canonicalRoot, locator.segments, locator.value)];
    if (files.length === 0) {
      throw invalidSource(
        "file source locator matched no regular files",
        "Correct the relative locator or add at least one matching source file.",
      );
    }
    files.sort((left, right) => compareText(left.logicalName, right.logicalName));

    const entries: SourceManifestFile[] = [];
    for (const file of files) {
      const content = await hashFile(file.path);
      entries.push({
        logicalName: file.logicalName,
        byteLength: content.byteLength,
        contentHash: content.contentHash,
      });
    }
    const manifest = createSourceManifest(entries);
    return Object.freeze({
      paths: Object.freeze(files.map((file) => file.path)),
      manifest,
    });
  } catch (cause) {
    if (cause instanceof EngineConfigurationError) {
      throw cause;
    }
    throw invalidSource(
      "file source could not be enumerated and hashed",
      "Check that the bound files are readable, stable, and beneath the binding root.",
    );
  }
}

export async function withStableFileSource<T>(
  root: string | undefined,
  locator: string,
  operation: (source: CapturedFileSource) => Promise<T>,
): Promise<StableFileSourceResult<T>> {
  const before = await captureBoundFileSource(root, locator);
  let outcome: { readonly value: T } | undefined;
  let operationFailure: unknown;
  try {
    outcome = { value: await operation(before) };
  } catch (cause) {
    operationFailure = cause;
  }

  let after: CapturedFileSource;
  try {
    after = await captureBoundFileSource(root, locator);
  } catch {
    throw sourceChanged();
  }
  assertUnchangedFileSource(before, after);
  if (outcome === undefined) {
    throw operationFailure;
  }
  return Object.freeze({ source: before, value: outcome.value });
}

export function assertUnchangedFileSource(
  before: CapturedFileSource,
  after: CapturedFileSource,
): void {
  if (before.manifest.manifestHash !== after.manifest.manifestHash) {
    throw sourceChanged();
  }
}

export function sourceChanged(): EngineConfigurationError {
  return new EngineConfigurationError(
    "SOURCE_CHANGED",
    "file source membership or content changed while a point-in-time view was being built",
    "Retry against a stable source version or snapshot the complete source set before reading.",
  );
}

async function resolveRoot(rootInput: string | undefined): Promise<string> {
  if (rootInput === undefined || !isAbsolute(rootInput)) {
    throw invalidSource(
      "DuckDB file bindings require an absolute root option",
      "Create the SourceBinding with options: { root: '/absolute/data/root' }.",
    );
  }
  const requested = resolve(rootInput);
  if (requested === parse(requested).root) {
    throw invalidSource(
      "DuckDB file binding root cannot be a filesystem root",
      "Bind the narrowest directory that contains the declared source.",
    );
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(requested);
  } catch {
    throw invalidSource(
      "file binding root does not exist",
      "Correct the binding root before reading the declared source.",
    );
  }
  const rootStatus = await stat(canonicalRoot);
  if (!rootStatus.isDirectory()) {
    throw invalidSource(
      "file binding root must resolve to a directory",
      "Bind a directory that contains the declared source files.",
    );
  }
  return canonicalRoot;
}

function parseLocator(input: string): ParsedLocator {
  if (typeof input !== "string" || input.length === 0) {
    throw invalidSource(
      "file source locator must be a non-empty relative path or glob",
      "Declare a root-relative file path or a portable *, ?, or ** glob.",
    );
  }
  if (
    input.includes("\\") ||
    input.includes("\0") ||
    isAbsolute(input) ||
    WINDOWS_DRIVE_PATTERN.test(input)
  ) {
    throw invalidSource(
      "portable file locators must be relative and use forward slashes",
      "Move the absolute path into SourceBinding.root and use a root-relative locator.",
    );
  }
  if (UNSUPPORTED_GLOB_PATTERN.test(input)) {
    throw invalidSource(
      "file source locator uses unsupported glob syntax",
      "Use only literal path segments, *, ?, and a whole-segment ** wildcard.",
    );
  }
  const segments = input.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw invalidSource(
      "file source locator contains an empty, current, or parent path segment",
      "Use one normalized root-relative locator without . or .. segments.",
    );
  }
  if (segments.some((segment) => segment.includes("**") && segment !== "**")) {
    throw invalidSource(
      "recursive ** must occupy a complete locator segment",
      "Use forms such as data/**/*.parquet rather than embedding ** in a file name.",
    );
  }
  return Object.freeze({
    value: input,
    segments: Object.freeze(segments),
    hasPattern: segments.some((segment) => segment.includes("*") || segment.includes("?")),
  });
}

async function resolveGlobFiles(
  canonicalRoot: string,
  locator: ParsedLocator,
): Promise<ResolvedFile[]> {
  const firstPattern = locator.segments.findIndex(
    (segment) => segment.includes("*") || segment.includes("?"),
  );
  const baseSegments = locator.segments.slice(0, firstPattern);
  const requestedBase = resolve(canonicalRoot, ...baseSegments);
  let canonicalBase: string;
  try {
    canonicalBase = await realpath(requestedBase);
  } catch {
    throw invalidSource(
      "file source glob base does not exist",
      "Correct the literal directory prefix before the first wildcard.",
    );
  }
  assertContained(canonicalRoot, canonicalBase);
  if (!(await stat(canonicalBase)).isDirectory()) {
    throw invalidSource(
      "file source glob base is not a directory",
      "Place wildcard segments beneath a real directory in the binding root.",
    );
  }

  const resolved: ResolvedFile[] = [];
  await walkDirectory(canonicalRoot, canonicalBase, baseSegments, locator.segments, resolved);
  return resolved;
}

async function walkDirectory(
  canonicalRoot: string,
  physicalDirectory: string,
  logicalDirectory: readonly string[],
  pattern: readonly string[],
  output: ResolvedFile[],
): Promise<void> {
  const entries = (await readdir(physicalDirectory, { withFileTypes: true })).sort((left, right) =>
    compareText(left.name, right.name),
  );
  for (const entry of entries) {
    const logicalSegments = [...logicalDirectory, entry.name];
    const physicalPath = join(physicalDirectory, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(canonicalRoot, physicalPath, logicalSegments, pattern, output);
      continue;
    }
    if (entry.isSymbolicLink()) {
      const canonicalTarget = await realpath(physicalPath);
      assertContained(canonicalRoot, canonicalTarget);
      const targetStatus = await stat(canonicalTarget);
      if (targetStatus.isDirectory()) {
        throw invalidSource(
          "file source glob traversal encountered a symbolic-link directory",
          "Replace the directory link with a real directory or use an explicit regular-file locator.",
        );
      }
      if (targetStatus.isFile() && matchesSegments(pattern, logicalSegments)) {
        output.push({ logicalName: logicalSegments.join("/"), path: canonicalTarget });
      } else if (matchesSegments(pattern, logicalSegments)) {
        throw invalidSource(
          "file source glob matched a non-regular filesystem entry",
          "Make every matched source member a regular file.",
        );
      }
      continue;
    }
    if (entry.isFile()) {
      if (matchesSegments(pattern, logicalSegments)) {
        output.push(
          await resolveCandidate(canonicalRoot, logicalSegments, logicalSegments.join("/")),
        );
      }
      continue;
    }
    if (matchesSegments(pattern, logicalSegments)) {
      throw invalidSource(
        "file source glob matched a non-regular filesystem entry",
        "Make every matched source member a regular file.",
      );
    }
  }
}

async function resolveCandidate(
  canonicalRoot: string,
  logicalSegments: readonly string[],
  logicalName: string,
): Promise<ResolvedFile> {
  let canonicalSource: string;
  try {
    canonicalSource = await realpath(resolve(canonicalRoot, ...logicalSegments));
  } catch {
    throw invalidSource(
      "declared file source does not exist",
      "Correct the declaration's relative source locator.",
    );
  }
  assertContained(canonicalRoot, canonicalSource);
  if (!(await stat(canonicalSource)).isFile()) {
    throw invalidSource(
      "file source must resolve to a regular file",
      "Point the declaration at one regular file or a glob matching regular files.",
    );
  }
  return Object.freeze({ logicalName, path: canonicalSource });
}

function assertContained(canonicalRoot: string, candidate: string): void {
  const relation = relative(canonicalRoot, candidate);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw invalidSource(
      "file source resolves outside its binding root",
      "Keep every source member inside the bound root and avoid escaping symlinks.",
    );
  }
}

async function hashFile(path: string): Promise<{ byteLength: number; contentHash: string }> {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    byteLength += bytes.byteLength;
    if (!Number.isSafeInteger(byteLength)) {
      throw invalidSource(
        "file source exceeds the supported byte length",
        "Split the source into smaller immutable files before reading.",
      );
    }
    hash.update(bytes);
  }
  return { byteLength, contentHash: `sha256:${hash.digest("hex")}` };
}

function matchesSegments(pattern: readonly string[], value: readonly string[]): boolean {
  const memo = new Map<string, boolean>();
  const visit = (patternIndex: number, valueIndex: number): boolean => {
    const key = `${patternIndex}:${valueIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let matched: boolean;
    if (patternIndex === pattern.length) {
      matched = valueIndex === value.length;
    } else if (pattern[patternIndex] === "**") {
      matched =
        visit(patternIndex + 1, valueIndex) ||
        (valueIndex < value.length && visit(patternIndex, valueIndex + 1));
    } else {
      const patternSegment = pattern[patternIndex];
      const valueSegment = value[valueIndex];
      matched =
        patternSegment !== undefined &&
        valueSegment !== undefined &&
        matchesSegment(patternSegment, valueSegment) &&
        visit(patternIndex + 1, valueIndex + 1);
    }
    memo.set(key, matched);
    return matched;
  };
  return visit(0, 0);
}

function matchesSegment(pattern: string, value: string): boolean {
  const memo = new Map<string, boolean>();
  const visit = (patternIndex: number, valueIndex: number): boolean => {
    const key = `${patternIndex}:${valueIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let matched: boolean;
    if (patternIndex === pattern.length) {
      matched = valueIndex === value.length;
    } else if (pattern[patternIndex] === "*") {
      matched =
        visit(patternIndex + 1, valueIndex) ||
        (valueIndex < value.length && visit(patternIndex, valueIndex + 1));
    } else {
      matched =
        valueIndex < value.length &&
        (pattern[patternIndex] === "?" || pattern[patternIndex] === value[valueIndex]) &&
        visit(patternIndex + 1, valueIndex + 1);
    }
    memo.set(key, matched);
    return matched;
  };
  return visit(0, 0);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidSource(message: string, remedy: string): EngineConfigurationError {
  return new EngineConfigurationError("INVALID_SOURCE", message, remedy);
}
