/** The running version: the `APP_VERSION` environment variable (set by the image build), else the version in the package. */
export function resolveAppVersion(
  packageVersion: string,
  environment: { APP_VERSION?: string | undefined } = process.env,
): string {
  return environment.APP_VERSION?.trim() || packageVersion
}
