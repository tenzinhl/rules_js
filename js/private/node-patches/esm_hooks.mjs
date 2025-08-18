// Written by hand. Couldn't be generated from TS with a compile command because
// having `module.register` in `register.cjs` breaks node toolchains in rules_js.

import fs from 'fs';

export async function resolve(specifier, context, next) {
    const nextResult = await next(specifier, context);
    const logfilepath = '/tmp/esm_hooks.log';
    const logstring = `${specifier} ==> ${JSON.stringify(nextResult, null, 2)}\n`;
    console.log(logstring);
    fs.appendFileSync(logfilepath, logstring);

    if (nextResult.url.startsWith("file://")) {
        // It wasn't a file, so skip our logic
        return nextResult
    }

    // Otherwise it was a file, let's see if the specifier realpath matches
    // the nextResult.url. If it does, we return the patched path instead.

    const realRealPath = fs._unpatched.realpathSync(specifier);
    console.log(`realRealPath=${realRealPath}\n`);
    const patchedRealPath = fs.realpathSync(specifier);
    console.log(`patchedRealPath=${patchedRealPath}\n`);

    
    console.log()
    return nextResult;
}
