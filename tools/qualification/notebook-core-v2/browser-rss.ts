export function sumPinnedBrowserCacheRss(processTable: string, cachePath: string): number {
  if (cachePath.length < 1) throw new Error("invalid pinned browser cache path");
  let kib = 0;
  for (const line of processTable.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match?.[1] || !match[2]?.includes(cachePath)) continue;
    kib += Number(match[1]);
  }
  return kib * 1024;
}
