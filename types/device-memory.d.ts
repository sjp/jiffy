// The Device Memory API. Chromium exposes `navigator.deviceMemory` (approximate
// RAM in GiB, rounded down to a power of two and clamped to 0.25–8); Firefox and
// Safari do not, and TypeScript's DOM lib doesn't declare it either. Optional
// here so every read has to handle its absence.
interface Navigator {
  readonly deviceMemory?: number;
}

interface WorkerNavigator {
  readonly deviceMemory?: number;
}
