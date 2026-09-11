export function canUseExtensionPageStorage(
  locationLike: { protocol?: string } | undefined = globalThis.location,
): boolean {
  const protocol = locationLike?.protocol;
  return protocol === 'chrome-extension:' || protocol === 'moz-extension:';
}
