// TODO: import the fspathsync
// 
import { appendFileSync, _unpatched } from 'fs';

export async function resolve(specifier, context, next) {
  const nextResult = await next(specifier, context);

  const logfilepath = '/tmp/esm_hooks.log';
  appendFileSync(logfilepath, `nextResult=${JSON.stringify(nextResult)}\n`);
  _unpatched.appendFileSync(logfilepath, "_unpatched append RRAAAAA\n");

  return nextResult;
}
