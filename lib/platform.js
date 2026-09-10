// Platform gate. dsh-autostart is Windows-only by design (HKCU Run + wscript.exe).

/**
 * Whether the plugin's mechanisms exist on this platform.
 * @param platform - a `process.platform` value; defaults to the real one.
 */
export function isSupportedPlatform(platform = process.platform) {
  return platform === 'win32'
}

/**
 * Human-readable refusal reason for unsupported platforms.
 * @param platform - a `process.platform` value; defaults to the real one.
 */
export function unsupportedReason(platform = process.platform) {
  return `dsh-autostart only supports Windows; the current platform is "${platform}".`
}
