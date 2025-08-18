// Written by hand. Couldn't be generated from TS with a compile command because
// having `module.register` in `register.cjs` breaks node toolchains in rules_js.

import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

// Import the escape detection logic from fs.cjs
import { escapeFunction } from './fs.cjs';

function log(msg) {
    console.log(`${msg}`);
    fs.appendFileSync('/tmp/esm_hooks.log', `${msg}\n`);
}

function initializeRoots() {
    const rootsEnv = process.env.JS_BINARY__FS_PATCH_ROOTS;
    if (!rootsEnv) {
        return null;
    }

    const roots = rootsEnv.split(':').filter(root => fs.existsSync(root));
    if (roots.length !== 2) {
        log(`Got ${roots.length} roots from ${rootsEnv}, expected 2. roots=${roots}.`);
        return null;
    }

    // By definition in `js/private/test/snapshots/launcher.sh`, first path should be
    // the execroot, second is the runfiles. Naive algorithm we will apply is replace
    // all paths that start with execroot with runfiles prefix instead.
    log(`Initializing roots: ${roots}`);
    return roots;
}

const roots = initializeRoots();

// Initialize escape detection with the same roots used by the fs patcher
function initializeEscapeDetection() {
    if (!roots || !roots.length) {
        return null;
    }
    log(`Initializing escape detection with roots: ${roots}`);
    return escapeFunction(roots);
}

const escapeDetection = initializeEscapeDetection();

export async function resolve(specifier, context, next) {
    const nextResult = await next(specifier, context);

    log(`nextResult for ${specifier} ==> ${JSON.stringify(nextResult, null, 2)}`);

    // Only process file:// URLs
    if (!nextResult.url.startsWith("file://")) {
        log("Not a file:// URL, returning as-is");
        return nextResult;
    }

    // If escape detection is not available, return as-is
    if (!escapeDetection) {
        log("Escape detection not available, returning as-is");
        return nextResult;
    }

    // Convert the resolved URL to a file path
    const resolvedPath = fileURLToPath(nextResult.url);

    // If resolved URL is already within runfiles no work to do
    if (resolvedPath.startsWith(roots[1])) {
        log("Already within runfiles, returning as-is");
        return nextResult;
    }

    // Check if resolved URL is prefixed with execroot
    if (!resolvedPath.startsWith(roots[0])) {
        log("Not a workspace file, returning as-is");
        return nextResult;
    }

    // Path starts with execroot prfix. Replace the execroot prefix with the runfiles prefix.
    const runfilesPath = roots[1] + resolvedPath.slice(roots[0].length);

    log(`Corrected path for ${specifier} ==> ${runfilesPath}`);

    // Convert back to a URL and return
    const correctedUrl = pathToFileURL(runfilesPath).href;
    return {
        ...nextResult,
        url: correctedUrl
    };
}
