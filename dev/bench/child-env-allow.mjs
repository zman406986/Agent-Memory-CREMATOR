#!/usr/bin/env node
/**
 * The child environment allow-list both live runners share.
 *
 * **Deny by default:** a name not on a lane's list is removed, so `OTHER_KEY`,
 * `OPENAI_API_KEY` or any other credential cannot survive by not matching a
 * pattern. `CHILD_ENV_ALLOW` is the 40 names both lanes inherit — the
 * platform's process plumbing plus locale/time, the non-credential Windows
 * identity variables, and `PYTHONUTF8` (a host whose default codec is GBK
 * needs it to read UTF-8 JSON). A lane adds only what its host needs: the
 * opencode lane the three colour variables, the dsh lane the three home
 * variables Windows sets and its world redirect does not override.
 */

/** The 40 names both live lanes inherit. Frozen; never mutate. */
export const CHILD_ENV_ALLOW = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'OS', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)', 'ALLUSERSPROFILE', 'PUBLIC',
  'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA',
  'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'USERNAME', 'USERDOMAIN',
  'USERDOMAIN_ROAMINGPROFILE', 'COMPUTERNAME', 'PSMODULEPATH', 'SHELL', 'USER', 'LOGNAME',
  'PYTHONUTF8',
]);

/**
 * The three colour variables the opencode host reads. They change how a child
 * writes, never what it can reach, and they are not credentials.
 */
export const OPENCODE_ONLY = Object.freeze(['COLORTERM', 'FORCE_COLOR', 'NO_COLOR']);

/**
 * `HOMEDRIVE`, `HOMEPATH` and `DRIVERDATA` are real Windows variables, not
 * typos. The dsh lane's world redirect does not override them, so it keeps the
 * exact 43 names it inherited before this list existed.
 */
export const DSH_ONLY = Object.freeze(['HOMEDRIVE', 'HOMEPATH', 'DRIVERDATA']);

/**
 * The environment a spawned *helper* inherits: the 40-name base only.
 *
 * A helper is a child spawned to help the run, not to serve it — `npm` resolves
 * the global package root, `powershell.exe` reads the process table, `taskkill`
 * ends the host. None of them needs the route's key and none needs the world
 * redirect, so a key in the parent's environment cannot leak to one that has no
 * use for it. Deny by default, same as the lanes.
 * @param {Record<string, string | undefined>} [source]
 * @returns {Record<string, string>}
 */
export function helperEnv(source = process.env) {
  const allowed = new Set(CHILD_ENV_ALLOW);
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (allowed.has(name.toUpperCase())) env[name] = value;
  }
  return env;
}
