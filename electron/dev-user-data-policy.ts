import path from 'node:path';

/**
 * Resolve an explicitly isolated user-data directory for a development run.
 * The caller supplies the existing development/multiple-instance gate. An
 * invalid requested override must abort startup, never use production data.
 */
export function resolveDevUserDataDir(
  env: Readonly<Record<string, string | undefined>>,
  allowMultipleInstances: boolean
): string | null {
  const requestedPath = env['AWOO_DEV_USER_DATA_DIR']?.trim();
  if (!requestedPath) return null;

  if (!allowMultipleInstances) {
    throw new Error(
      'AWOO_DEV_USER_DATA_DIR requires development or multiple-instance mode.'
    );
  }

  // On Windows, \folder and /folder are rooted on the current drive, but
  // are not fully qualified paths suitable for an explicit isolation target.
  const root = path.parse(requestedPath).root;
  const driveRelativeRoot = path.sep === '\\' && (root === '\\' || root === '/');
  if (requestedPath.includes('\0') || !path.isAbsolute(requestedPath) || driveRelativeRoot) {
    throw new Error('AWOO_DEV_USER_DATA_DIR must be a fully qualified absolute path.');
  }

  return path.normalize(requestedPath);
}

/** Isolated development must not install/update unrelated player connectors. */
export function shouldRunAutomaticConnectorMaintenance(
  devUserDataDir: string | null
): boolean {
  return devUserDataDir === null;
}
