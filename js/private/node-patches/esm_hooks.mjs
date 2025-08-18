// Written by hand. Couldn't be generated from TS with a compile command because
// having `module.register` in `register.cjs` breaks node toolchains in rules_js.

import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

// Import the escape detection logic from fs.cjs
import { escapeFunction } from './fs.cjs';

// Initialize escape detection with the same roots used by the fs patcher
function initializeEscapeDetection() {
    const rootsEnv = process.env.JS_BINARY__FS_PATCH_ROOTS;
    if (!rootsEnv) {
        return null;
    }

    const roots = rootsEnv.split(':').filter(root => fs.existsSync(root));
    if (!roots.length) {
        return null;
    }

    return escapeFunction(roots);
}

const escapeDetection = initializeEscapeDetection();

export async function resolve(specifier, context, next) {
    const nextResult = await next(specifier, context);

    console.log(`nextResult for ${specifier} ==> ${JSON.stringify(nextResult, null, 2)}`);

    // Only process file:// URLs
    if (!nextResult.url.startsWith("file://")) {
        console.log("Not a file:// URL, returning as-is");
        return nextResult;
    }

    // If escape detection is not available, return as-is
    if (!escapeDetection) {
        console.log("Escape detection not available, returning as-is");
        return nextResult;
    }

    // Convert the resolved URL to a file path
    // NOTE(tenzin): Unfortunately by this point since the URL is already resolved, we don't have the
    // original path with symlink :/ (darn). I think correct approach needs to be to copy the default
    // resolve implementation and then just intercept the realpath call in finalize.
    const resolvedPath = fileURLToPath(nextResult.url);

    // Use the unpatched realpath to get the actual file system path
    let realPath;
    try {
        realPath = fs._unpatched.realpathSync(resolvedPath);
    } catch (err) {
        // If we can't resolve the path, return the original result
        console.log(`Failed to resolve real path for ${resolvedPath}: ${err.message}`);
        console.log("Returning as-is");
        return nextResult;
    }

    // Check if this represents a sandbox escape
    console.log(`Checking if ${resolvedPath} -> ${realPath} is an escape`);
    const escapedRoot = escapeDetection.isEscape(resolvedPath, realPath);
    if (escapedRoot) {
        console.log("!!!!! Sandbox escape detected for " + specifier);
        // Use the patched realpath to get the corrected path within the sandbox
        const patchedPath = fs.realpathSync(resolvedPath);
        const correctedUrl = pathToFileURL(patchedPath).href;

        return {
            ...nextResult,
            url: correctedUrl
        };
    }

    return nextResult;
}
