import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export const MAX_DIRECTORY_ENTRIES = 500;

function isAbsoluteInput(value) {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function entryType(value) {
  if (value.isDirectory()) return "directory";
  if (value.isFile()) return "file";
  if (value.isSymbolicLink()) return "symlink";
  return "other";
}

function compareEntries(a, b) {
  const rank = { directory: 0, file: 1, symlink: 2, other: 3 };
  const typeDelta = rank[entryType(a)] - rank[entryType(b)];
  if (typeDelta !== 0) return typeDelta;

  const aFolded = a.name.toLowerCase();
  const bFolded = b.name.toLowerCase();
  if (aFolded < bFolded) return -1;
  if (aFolded > bFolded) return 1;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

function relativeDisplayPath(root, target) {
  const relative = path.relative(root, target);
  if (!relative) return ".";
  return relative.split(path.sep).join("/");
}

function resultBase(projectId, root, target) {
  return {
    project: projectId,
    path: relativeDisplayPath(root, target)
  };
}

function refused(projectId, root, target, message) {
  return {
    ok: false,
    status: "refused",
    ...resultBase(projectId, root, target),
    message
  };
}

export async function listProjectDirectory({ projectId, project, requestedPath = "." }) {
  const root = path.resolve(project.root);
  const requested = requestedPath === "" ? "." : requestedPath;

  if (typeof requested !== "string" || isAbsoluteInput(requested)) {
    return refused(projectId, root, root, "Directory path must be relative to the project root.");
  }

  const target = path.resolve(root, requested);
  if (!isInside(root, target)) {
    return refused(projectId, root, root, "Requested path escapes the project root.");
  }

  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ok: false,
        status: "not_found",
        ...resultBase(projectId, root, target),
        message: "Project root does not exist."
      };
    }
    return refused(projectId, root, target, "Project root is not accessible.");
  }

  let realTarget;
  try {
    realTarget = await realpath(target);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return {
        ok: false,
        status: "not_found",
        ...resultBase(projectId, root, target),
        message: "Directory path does not exist."
      };
    }
    return refused(projectId, root, target, "Directory path is not accessible.");
  }

  if (!isInside(realRoot, realTarget)) {
    return refused(projectId, root, target, "Requested path resolves outside the project root.");
  }

  let targetStat;
  try {
    targetStat = await lstat(realTarget);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ok: false,
        status: "not_found",
        ...resultBase(projectId, root, target),
        message: "Directory path does not exist."
      };
    }
    return refused(projectId, root, target, "Directory path is not accessible.");
  }

  if (!targetStat.isDirectory()) {
    return {
      ok: false,
      status: "not_directory",
      ...resultBase(projectId, root, target),
      message: "Requested path is not a directory."
    };
  }

  let dirents;
  try {
    dirents = await readdir(realTarget, { withFileTypes: true });
  } catch {
    return refused(projectId, root, target, "Directory cannot be listed.");
  }

  dirents.sort(compareEntries);
  const truncated = dirents.length > MAX_DIRECTORY_ENTRIES;
  const selected = dirents.slice(0, MAX_DIRECTORY_ENTRIES);

  const entries = await Promise.all(selected.map(async (dirent) => {
    const fallbackType = entryType(dirent);
    let stat = null;
    try {
      stat = await lstat(path.join(realTarget, dirent.name));
    } catch {
      // The entry may have changed after readdir. Keep only non-sensitive Dirent metadata.
    }

    const type = stat ? entryType(stat) : fallbackType;
    return {
      name: dirent.name,
      type,
      size_bytes: type === "file" && stat ? stat.size : null
    };
  }));

  return {
    ok: true,
    status: "completed",
    ...resultBase(projectId, root, target),
    entries,
    truncated
  };
}
