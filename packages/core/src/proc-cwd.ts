/** Fold `lsof -Fn` process/name rows into a pid-to-cwd map. */
export function lsofCwdRows(lout: string, cwdMap: Map<number, string>): void {
  let currentPid: number | null = null;
  for (const line of lout.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1));
      currentPid = Number.isInteger(pid) ? pid : null;
      continue;
    }
    if (line.startsWith('n') && currentPid !== null) {
      cwdMap.set(currentPid, line.slice(1));
    }
  }
}
