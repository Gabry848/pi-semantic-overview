export function modelReference(provider: string, modelId: string): `${string}/${string}` {
  return `${provider}/${modelId}`;
}

/** Pi model references are split only at the first slash; model IDs may contain slashes or whitespace. */
export function parseModelReference(value: string): { provider: string; modelId: string } | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export function isExactModelReference(value: string): boolean {
  return parseModelReference(value) !== undefined;
}
