export function getDataDirectory(
  environment: Record<string, string | undefined> = process.env
): string {
  return environment.TOASTTV_DATA?.trim() || './data'
}

export function getDataPathForEnvironment(
  environment: Record<string, string | undefined>,
  ...segments: string[]
): string {
  const dataDirectory = getDataDirectory(environment).replace(/[\\/]+$/, '')
  const separator = dataDirectory.includes('\\') ? '\\' : '/'
  const cleanSegments = segments.map((segment) =>
    segment.replace(/^[\\/]+|[\\/]+$/g, '')
  )
  return [dataDirectory, ...cleanSegments].join(separator)
}

export function getDataPath(...segments: string[]): string {
  return getDataPathForEnvironment(process.env, ...segments)
}
