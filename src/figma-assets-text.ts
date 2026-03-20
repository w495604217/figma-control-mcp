function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function normalizeFigmaAssetsText(text: string | undefined): string {
  return collapseWhitespace(text ?? "");
}

export function canonicalizeFigmaAssetsText(text: string | undefined): string {
  return normalizeFigmaAssetsText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeVisibleLibraryName(text: string | undefined): string {
  let value = normalizeFigmaAssetsText(text)
    .replace(/\s+[g0o]$/iu, "")
    .replace(/\s+[^\x00-\x7F]{1,3}$/u, "")
    .replace(/\s+[©®°•·]+$/u, "");

  value = value
    .replace(/\bios\b/giu, "iOS")
    .replace(/\bipados\b/giu, "iPadOS")
    .replace(/\bmacos\b/giu, "macOS");

  return collapseWhitespace(value);
}

export function normalizeVisibleLibraryDetail(text: string | undefined): string {
  return normalizeFigmaAssetsText(text)
    .replace(/\bcomponent\b/giu, "components")
    .replace(/\bicon\b/giu, "icons")
    .replace(/\bstyle\b/giu, "styles")
    .replace(/\bvariable\b/giu, "variables");
}
