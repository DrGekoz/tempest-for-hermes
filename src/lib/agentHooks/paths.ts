// Tiny path helpers shared by adapters. Rust hands us native paths (backslashes
// on Windows); config/script paths are built native, and forward-slash variants
// are only needed for the Git-Bash-invoked command wrapper.

export function sepFor(windows: boolean): string {
  return windows ? "\\" : "/";
}

export function joinNative(windows: boolean, ...parts: string[]): string {
  return parts.join(sepFor(windows));
}

export function toFwd(p: string): string {
  return p.replace(/\\/g, "/");
}
