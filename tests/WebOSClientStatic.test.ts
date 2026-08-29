import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import ts from 'typescript'

const root = join(import.meta.dir, '..', 'clients', 'webos')

/* The TV bundle has no module system, no build step and no linter, so a name
 * that is referenced but never declared parses cleanly and only fails as a
 * ReferenceError on the device. Two have shipped that way: `rangeEnd`, which
 * aborted every channel switch in 0.3.12, and `requestBaseline`, left behind
 * when the range snapshot it fed was removed.
 *
 * TypeScript in checkJs mode reports exactly that as TS2304, and it is already
 * a dependency here. Only that diagnostic is asserted on: the bundle reaches
 * `window.ToastTV*` and webOS globals that no DOM lib knows about, and typing
 * those would be a project of its own for no extra safety.
 */
const CANNOT_FIND_NAME = 2304

function cannotFindNameDiagnostics(files: readonly string[]): string[] {
  const program = ts.createProgram(files, {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ES5,
    lib: ['lib.es5.d.ts', 'lib.dom.d.ts'],
    types: [],
    skipLibCheck: true,
  })
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.code === CANNOT_FIND_NAME)
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
      if (!diagnostic.file || diagnostic.start === undefined) return message
      const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      const name = diagnostic.file.fileName.split('/').pop()
      return `${name}:${line + 1} ${message}`
    })
}

describe('webOS client static checks', () => {
  test('references no name the bundle never declares', () => {
    const found = cannotFindNameDiagnostics([
      join(root, 'app.js'),
      join(root, 'playback-policy.js'),
      join(root, 'playback-engine.js'),
      join(root, 'switch-machine.js'),
    ])

    expect(found).toEqual([])
  }, 60000)

  test('the check actually catches a missing declaration', () => {
    // A guard that cannot fail is worse than no guard, so prove this one fires.
    const broken = join(import.meta.dir, 'fixtures', 'webos-missing-name.js')
    const found = cannotFindNameDiagnostics([broken])

    expect(found).toHaveLength(1)
    expect(found[0]).toContain('neverDeclared')
  }, 60000)
})
