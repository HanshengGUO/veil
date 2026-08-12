import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface ArtifactFileRecord {
  path: string;
  bytes: number;
  sha256: string;
}

export interface AgentArtifactManifest {
  schemaVersion: 1;
  files: ArtifactFileRecord[];
  treeSha256: string;
}

function filesBelow(directory: string, root = directory): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`artifact tree contains a symbolic link: ${relative(root, path)}`);
    }
    if (entry.isDirectory()) files.push(...filesBelow(path, root));
    else if (entry.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
  }
  return files.sort();
}

export function collectArtifactManifest(root: string): AgentArtifactManifest {
  const files = filesBelow(root).map((path): ArtifactFileRecord => {
    const absolute = join(root, path);
    return {
      path,
      bytes: statSync(absolute).size,
      sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
    };
  });
  const tree = createHash("sha256");
  for (const file of files) {
    tree
      .update(file.path)
      .update("\0")
      .update(String(file.bytes))
      .update("\0")
      .update(file.sha256)
      .update("\n");
  }
  return { schemaVersion: 1, files, treeSha256: tree.digest("hex") };
}

export function writeArtifactManifest(root: string, output: string): AgentArtifactManifest {
  const manifest = collectArtifactManifest(root);
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
