/** Format size in GiB (backend sends binary): show as TB when >= 1024 to match Steam (e.g. 937.5 GB, 1.8 TB). */
export function formatStorageGb(gb: number): string {
  if (gb >= 1024) {
    const tb = gb / 1024;
    return tb % 1 === 0 ? `${tb} TB` : `${tb.toFixed(1)} TB`;
  }
  return gb % 1 === 0 ? `${gb} GB` : `${gb.toFixed(1)} GB`;
}
