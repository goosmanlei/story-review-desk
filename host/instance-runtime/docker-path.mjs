/** Docker Desktop's VM may expose an exact macOS bind under /host_mnt. */
export function dockerHostPath(value) {
  return process.platform === 'darwin' && typeof value === 'string' && value.startsWith('/host_mnt/')
    ? value.slice('/host_mnt'.length)
    : value;
}
