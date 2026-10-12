export type RedirectLookup = (sourcePath: string) => Promise<string | null>;

export function assertSafeRedirectPath(path: string, field: string): void {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /%(?:2f|5c)/i.test(path) ||
    /[\u0000-\u0020\u007f\\]/.test(path)
  ) {
    throw new Error(`${field} deve ser um caminho local seguro do portal.`);
  }
}

export async function assertRedirectDoesNotLoop(
  sourcePath: string,
  targetPath: string,
  lookupTarget: RedirectLookup,
): Promise<void> {
  assertSafeRedirectPath(sourcePath, "A origem");
  assertSafeRedirectPath(targetPath, "O destino");

  const visited = new Set([sourcePath]);
  let currentPath: string | null = targetPath;

  while (currentPath !== null) {
    assertSafeRedirectPath(currentPath, "O destino existente");
    if (visited.has(currentPath)) {
      throw new Error("O redirecionamento criaria um loop.");
    }

    visited.add(currentPath);
    currentPath = await lookupTarget(currentPath);
  }
}
