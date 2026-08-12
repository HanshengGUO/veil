import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface WorkspaceRuntimeDirectories {
  root: string;
  home: string;
  temporary: string;
  cache: string;
  config: string;
}

const SENSITIVE_NAMES = new Set([
  "ALL_PROXY",
  "DATABASE_URL",
  "GIT_ASKPASS",
  "GPG_AGENT_INFO",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NETRC",
  "NPM_CONFIG_USERCONFIG",
  "SSH_AUTH_SOCK",
  "all_proxy",
  "http_proxy",
  "https_proxy",
]);

const SENSITIVE_NAME =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|PRIVATE_?KEY)(?:$|_)/i;

function pathIsInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
  );
}

function nearestExistingPath(path: string): string {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return candidate;
}

/**
 * Resolve a file-tool path into the workspace and reject lexical or symlink escapes.
 *
 * `/workspace` and `/tmp/work` are accepted as sandbox-visible aliases. This keeps tool behavior
 * stable when a runner later moves from a host path to a container/bwrap mount.
 */
export function normalizeWorkspacePath(
  workspace: string,
  requested: string,
  aliases: readonly string[] = ["/workspace", "/tmp/work"],
): string {
  const root = resolve(workspace);
  const rootReal = realpathSync(root);
  let target: string;

  if (!isAbsolute(requested)) {
    target = resolve(root, requested);
  } else if (pathIsInside(root, resolve(requested))) {
    target = resolve(requested);
  } else {
    const alias = aliases.find(
      (candidate) =>
        requested === candidate ||
        requested.startsWith(`${candidate}/`) ||
        requested.startsWith(`${candidate}\\`),
    );
    if (alias === undefined) throw new Error(`tool path escapes the workspace: ${requested}`);
    target = resolve(root, requested.slice(alias.length).replace(/^[/\\]+/, ""));
  }

  if (!pathIsInside(root, target)) {
    throw new Error(`tool path escapes the workspace: ${requested}`);
  }
  const existingReal = realpathSync(nearestExistingPath(target));
  if (!pathIsInside(rootReal, existingReal)) {
    throw new Error(`tool path follows a link outside the workspace: ${requested}`);
  }
  return target;
}

type ExecutableTool = {
  execute: (...args: unknown[]) => unknown;
};

/** Add workspace containment to Pi file tools without changing their public schemas. */
export function restrictPathTool<T extends object>(workspace: string, tool: T): T {
  const executable = tool as unknown as ExecutableTool;
  return {
    ...tool,
    execute: (...args: unknown[]) => {
      const params = args[1];
      if (typeof params !== "object" || params === null || !("path" in params)) {
        throw new Error("tool path must be a string");
      }
      const requested = (params as { path?: unknown }).path;
      if (typeof requested !== "string") throw new Error("tool path must be a string");
      const forwarded = [...args];
      forwarded[1] = { ...params, path: normalizeWorkspacePath(workspace, requested) };
      return executable.execute(...forwarded);
    },
  } as T;
}

export function prepareWorkspaceRuntime(workspace: string): WorkspaceRuntimeDirectories {
  const root = join(workspace, ".veil-runtime");
  const directories = {
    root,
    home: join(root, "home"),
    temporary: join(root, "tmp"),
    cache: join(root, "cache"),
    config: join(root, "config"),
  };
  for (const directory of Object.values(directories)) mkdirSync(directory, { recursive: true });
  return directories;
}

export function sanitizeChildEnvironment(
  environment: NodeJS.ProcessEnv,
  runtime: WorkspaceRuntimeDirectories,
  additionalSensitiveNames: readonly string[] = [],
): NodeJS.ProcessEnv {
  const additional = new Set(additionalSensitiveNames);
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (
      value === undefined ||
      additional.has(name) ||
      SENSITIVE_NAMES.has(name) ||
      SENSITIVE_NAME.test(name) ||
      name.startsWith("AWS_")
    ) {
      continue;
    }
    sanitized[name] = value;
  }
  sanitized.HOME = runtime.home;
  sanitized.TMPDIR = runtime.temporary;
  sanitized.TMP = runtime.temporary;
  sanitized.TEMP = runtime.temporary;
  sanitized.XDG_CACHE_HOME = runtime.cache;
  sanitized.XDG_CONFIG_HOME = runtime.config;
  return sanitized;
}

export function redactSensitiveValues(message: string, values: readonly string[]): string {
  let redacted = message;
  for (const value of values) {
    if (value.length >= 4) redacted = redacted.replaceAll(value, "[REDACTED]");
  }
  return redacted;
}
