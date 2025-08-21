/**
 * @license
 * Copyright 2019 The Bazel Authors. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { PathLike, Stats } from 'fs'
import type * as FsType from 'fs'
import type * as UrlType from 'url'
import * as path from 'path'
import * as util from 'util'

// windows cant find the right types
type Dir = any
type Dirent = any

// Including node internal type definitions for checking.

interface ReadFileContext {
    fd: number | undefined;
    isUserFd: boolean | undefined;
    size: number;
    callback: (err?: Error, data?: string | Uint8Array) => unknown;
    buffers: Uint8Array[];
    buffer: Uint8Array;
    pos: number;
    encoding: string;
    err: Error | null;
    signal: unknown /* AbortSignal | undefined */;
}

// Internal Node.js types that aren't exposed in public @types/node
declare namespace InternalFSBinding {
    class FSReqCallback<ResultType = unknown> {
        constructor(bigint?: boolean);
        oncomplete: ((error: Error) => void) | ((error: null, result: ResultType) => void);
        context: ReadFileContext;
    }

    interface FSSyncContext {
        fd?: number;
        path?: string;
        dest?: string;
        errno?: string;
        message?: string;
        syscall?: string;
        error?: Error;
    }
}

// Additional internal types for function overloads
type StringOrBuffer = string | Buffer;
declare const kUsePromises: unique symbol;

// using require here on purpose so we can override methods with any
// also even though imports are mutable in typescript the cognitive dissonance is too high because
// es modules
const _fs = require('node:fs') as typeof FsType
const url = require('node:url') as typeof UrlType

const HOP_NON_LINK = Symbol.for('HOP NON LINK')
const HOP_NOT_FOUND = Symbol.for('HOP NOT FOUND')

type HopResults = string | typeof HOP_NON_LINK | typeof HOP_NOT_FOUND

export function patcher(
    fs: any = _fs,
    roots: string[],
    useLstatPatch: boolean
) {
    fs = fs || _fs
    // Make the original version of the library available for when access to the
    // unguarded file system is necessary, such as the esbuild plugin that
    // protects against sandbox escaping that occurs through module resolution
    // in the Go binary. See
    // https://github.com/aspect-build/rules_esbuild/issues/58.
    fs._unpatched = { ...fs }
    roots = roots || []
    roots = roots.filter((root) => fs.existsSync(root))
    if (!roots.length) {
        if (process.env.VERBOSE_LOGS) {
            console.error(
                'fs patcher called without any valid root paths ' + __filename
            )
        }
        return
    }

    const origLstat = fs.lstat.bind(fs) as typeof FsType.lstat
    const origLstatSync = fs.lstatSync.bind(fs) as typeof FsType.lstatSync

    const origReaddir = fs.readdir.bind(fs) as typeof FsType.readdir
    const origReaddirSync = fs.readdirSync.bind(fs) as typeof FsType.readdirSync

    const origReadlink = fs.readlink.bind(fs) as typeof FsType.readlink
    const origReadlinkSync = fs.readlinkSync.bind(
        fs
    ) as typeof FsType.readlinkSync

    const origRealpath = fs.realpath.bind(fs) as typeof FsType.realpath
    const origRealpathNative = fs.realpath
        .native as typeof FsType.realpath.native
    const origRealpathSync = fs.realpathSync.bind(
        fs
    ) as typeof FsType.realpathSync
    const origRealpathSyncNative = fs.realpathSync
        .native as typeof FsType.realpathSync.native

    const { isInBazelRoot, isEscape } = escapeFunction(roots)

    // =========================================================================
    // fs.lstat
    // =========================================================================

    fs.lstat = function lstat(...args: Parameters<typeof FsType.lstat>) {
        // preserve error when calling function without required callback
        if (typeof args[args.length - 1] !== 'function') {
            return origLstat(...args)
        }

        const cb = once(args[args.length - 1] as any)

        // override the callback
        args[args.length - 1] = function lstatCb(err: Error, stats: Stats) {
            if (err) return cb(err)

            if (!stats.isSymbolicLink()) {
                // the file is not a symbolic link so there is nothing more to do
                return cb(null, stats)
            }

            args[0] = resolvePathLike(args[0])

            if (!isInBazelRoot(args[0])) {
                // The requested path isn't within a bazel root to begin with so there's
                // no "escaping" to fix.
                return cb(null, stats)
            }

            return guardedReadLink(args[0], guardedReadLinkCb)

            function guardedReadLinkCb(str: string) {
                if (str != args[0]) {
                    // there are one or more hops within the guards so there is nothing more to do
                    return cb(null, stats)
                }

                // there are no hops so lets report the stats of the real file;
                // we can't use origRealPath here since that function calls lstat internally
                // which can result in an infinite loop
                return unguardedRealPath(args[0], unguardedRealPathCb)

                function unguardedRealPathCb(err: Error, str: string) {
                    if (err) {
                        if ((err as any).code === 'ENOENT') {
                            // broken link so there is nothing more to do
                            return cb(null, stats)
                        }
                        return cb(err)
                    }
                    return origLstat(str, cb)
                }
            }
        }

        origLstat(...args)
    }

    fs.lstatSync = function lstatSync(
        ...args: Parameters<typeof FsType.lstatSync>
    ) {
        const stats = origLstatSync(...args)

        if (!stats?.isSymbolicLink()) {
            // the file is not a symbolic link so there is nothing more to do
            return stats
        }

        args[0] = resolvePathLike(args[0])

        if (!isInBazelRoot(args[0])) {
            // The requested path isn't within a bazel root to begin with so there's
            // no "escaping" to fix.
            return stats
        }

        const guardedReadLink: string = guardedReadLinkSync(args[0])
        if (guardedReadLink != args[0]) {
            // there are one or more hops within the guards so there is nothing more to do
            return stats
        }

        try {
            args[0] = unguardedRealPathSync(args[0])

            // there are no hops so lets report the stats of the real file;
            // we can't use origRealPathSync here since that function calls lstat internally
            // which can result in an infinite loop
            return origLstatSync(...args)
        } catch (err) {
            if (err.code === 'ENOENT') {
                // broken link so there is nothing more to do
                return stats
            }
            throw err
        }
    }

    // =========================================================================
    // fs.realpath
    // =========================================================================

    fs.realpath = function realpath(...args: Parameters<typeof origRealpath>) {
        // preserve error when calling function without required callback
        if (typeof args[args.length - 1] !== 'function') {
            return origRealpath(...args)
        }

        const cb = once(args[args.length - 1] as any)

        args[args.length - 1] = function realpathCb(err: Error, str: string) {
            if (err) return cb(err)
            const escapedRoot: string | false = isEscape(args[0], str)
            if (escapedRoot) {
                return guardedRealPath(args[0], cb, escapedRoot)
            } else {
                return cb(null, str)
            }
        }

        origRealpath(...args)
    }

    fs.realpath.native = function realpath_native(
        ...args: Parameters<typeof origRealpathNative>
    ) {
        // preserve error when calling function without required callback
        if (typeof args[args.length - 1] !== 'function') {
            return origRealpathNative(...args)
        }

        const cb = once(args[args.length - 1] as any)

        args[args.length - 1] = function nativeCb(err: Error, str: string) {
            if (err) return cb(err)
            const escapedRoot: string | false = isEscape(args[0], str)
            if (escapedRoot) {
                return guardedRealPath(args[0], cb, escapedRoot)
            } else {
                return cb(null, str)
            }
        }

        origRealpathNative(...args)
    }

    fs.realpathSync = function realpathSync(
        ...args: Parameters<typeof origRealpathSync>
    ) {
        const str = origRealpathSync(...args)
        const escapedRoot: string | false = isEscape(args[0], str)
        if (escapedRoot) {
            return guardedRealPathSync(args[0], escapedRoot)
        }
        return str
    }

    fs.realpathSync.native = function native_realpathSync(
        ...args: Parameters<typeof origRealpathSyncNative>
    ) {
        const str = origRealpathSyncNative(...args)
        const escapedRoot: string | false = isEscape(args[0], str)
        if (escapedRoot) {
            return guardedRealPathSync(args[0], escapedRoot)
        }
        return str
    }

    // =========================================================================
    // fs.readlink
    // =========================================================================

    fs.readlink = function readlink(...args: Parameters<typeof origReadlink>) {
        // preserve error when calling function without required callback
        if (typeof args[args.length - 1] !== 'function') {
            return origReadlink(...args)
        }

        const cb = once(args[args.length - 1] as any)

        args[args.length - 1] = function readlinkCb(err: Error, str: string) {
            if (err) return cb(err)
            const resolved = resolvePathLike(args[0])
            str = path.resolve(path.dirname(resolved), str)
            const escapedRoot: string | false = isEscape(resolved, str)
            if (escapedRoot) {
                return nextHop(str, readlinkNextHopCb)

                function readlinkNextHopCb(next: string | false) {
                    if (!next) {
                        if (next == undefined) {
                            // The escape from the root is not mappable back into the root; throw EINVAL
                            return cb(enoent('readlink', args[0]))
                        } else {
                            // The escape from the root is not mappable back into the root; throw EINVAL
                            return cb(einval('readlink', args[0]))
                        }
                    }
                    next = path.resolve(
                        path.dirname(resolved),
                        path.relative(path.dirname(str), next)
                    )
                    if (
                        next != resolved &&
                        !isEscape(resolved, next, [escapedRoot as string])
                    ) {
                        return cb(null, next)
                    }
                    // The escape from the root is not mappable back into the root; we must make
                    // this look like a real file so we call readlink on the realpath which we
                    // expect to return an error
                    return origRealpath(resolved, readlinkRealpathCb)

                    function readlinkRealpathCb(
                        err: NodeJS.ErrnoException,
                        str: string
                    ) {
                        if (err) return cb(err)
                        return origReadlink(str, cb)
                    }
                }
            } else {
                return cb(null, str)
            }
        }

        origReadlink(...args)
    }

    fs.readlinkSync = function readlinkSync(
        ...args: Parameters<typeof origReadlinkSync>
    ) {
        const resolved = resolvePathLike(args[0])

        const str = path.resolve(
            path.dirname(resolved),
            origReadlinkSync(...args)
        )

        const escapedRoot: string | false = isEscape(resolved, str)
        if (escapedRoot) {
            // The symlink escapes the root, but maybe if we resolve other
            // symlinks in the path we can get back into the root, so let's
            // try to take another hop preferring one that keeps us in the
            // sandbox. (NOTE(tenzin): I'm not sure why this would ever be the case).
            let next: string | false = nextHopSync(str)
            if (!next) {
                // The escape from the root is not mappable back into the root
                // NOTE(tenzin): I think technically both of these branches
                // should be unreachable, since if we were able to resolve the
                // symlink with `origReadlinkSync`, it should both be a defined
                // file and have symlink path elements. This code seems strange.
                if (next == undefined) {
                    // `str` isn't even a valid path to a file; throw ENOENT
                    throw enoent('readlink', args[0])
                } else {
                    // `str` is not a symlink; throw EINVAL
                    throw einval('readlink', args[0])
                }
            }
            next = path.resolve(
                path.dirname(resolved),
                path.relative(path.dirname(str), next)
            )
            if (next != resolved && !isEscape(resolved, next, [escapedRoot])) {
                return next
            }
            // The escape from the root is not mappable back into the root; throw EINVAL
            // In the case of the file existing, this is equivalent to telling the caller
            // the file is not a symbolic link (this is how we keep things contained to the roots).
            throw einval('readlink', args[0])
        }
        return str
    }

    // =========================================================================
    // fs.readdir
    // =========================================================================

    fs.readdir = function readdir(...args: Parameters<typeof origReaddir>) {
        // preserve error when calling function without required callback
        if (typeof args[args.length - 1] !== 'function') {
            return origReaddir(...args)
        }

        const cb = once(args[args.length - 1] as any)
        const p = resolvePathLike(args[0])

        args[args.length - 1] = function readdirCb(
            err: Error,
            result: Dirent[]
        ) {
            if (err) return cb(err)
            // user requested withFileTypes
            if (result[0] && result[0].isSymbolicLink) {
                Promise.all(result.map((v: Dirent) => handleDirent(p, v)))
                    .then(() => {
                        cb(null, result)
                    })
                    .catch((err) => {
                        cb(err)
                    })
            } else {
                // string array return for readdir.
                cb(null, result)
            }
        }

        origReaddir(...args)
    }

    fs.readdirSync = function readdirSync(
        ...args: Parameters<typeof origReaddirSync>
    ) {
        const res = origReaddirSync(...args)
        const p = resolvePathLike(args[0])
        res.forEach((v: Dirent | any) => {
            handleDirentSync(p, v)
        })
        return res
    }

    // =========================================================================
    // fs.opendir
    // =========================================================================

    if (fs.opendir) {
        const origOpendir = fs.opendir.bind(fs)
        fs.opendir = function opendir(...args: Parameters<typeof origOpendir>) {
            // if this is not a function opendir should throw an error.
            // we call it so we don't have to throw a mock
            if (typeof args[args.length - 1] === 'function') {
                const cb = once(args[args.length - 1] as any)
                args[args.length - 1] = async function opendirCb(
                    err: Error,
                    dir: Dir
                ) {
                    try {
                        cb(null, await handleDir(dir))
                    } catch (err) {
                        cb(err)
                    }
                }
                origOpendir(...args)
            } else {
                return origOpendir(...args).then((dir: Dir) => {
                    return handleDir(dir)
                })
            }
        }
    }

    // =========================================================================
    // fs.promises
    // =========================================================================

    /**
     * patch fs.promises here.
     *
     * this requires a light touch because if we trigger the getter on older nodejs versions
     * it will log an experimental warning to stderr
     *
     * `(node:62945) ExperimentalWarning: The fs.promises API is experimental`
     *
     * this api is available as experimental without a flag so users can access it at any time.
     */
    const promisePropertyDescriptor = Object.getOwnPropertyDescriptor(
        fs,
        'promises'
    )
    if (promisePropertyDescriptor) {
        const promises: any = {}
        promises.lstat = util.promisify(fs.lstat)
        // NOTE: node core uses the newer realpath function fs.promises.native instead of fs.realPath
        promises.realpath = util.promisify(fs.realpath.native)
        promises.readlink = util.promisify(fs.readlink)
        promises.readdir = util.promisify(fs.readdir)
        if (fs.opendir) promises.opendir = util.promisify(fs.opendir)
        // handle experimental api warnings.
        // only applies to version of node where promises is a getter property.
        if (promisePropertyDescriptor.get) {
            const oldGetter = promisePropertyDescriptor.get.bind(fs)
            const cachedPromises = {}

            promisePropertyDescriptor.get = () => {
                const _promises = oldGetter()
                Object.assign(cachedPromises, _promises, promises)
                return cachedPromises
            }
            Object.defineProperty(fs, 'promises', promisePropertyDescriptor)
        } else {
            // api can be patched directly
            Object.assign(fs.promises, promises)
        }
    }

    // =========================================================================
    // helper functions for dirs
    // =========================================================================

    async function handleDir(dir: Dir) {
        const p = path.resolve(dir.path)
        const origIterator = dir[Symbol.asyncIterator].bind(dir)
        const origRead: any = dir.read.bind(dir)

        dir[Symbol.asyncIterator] = async function* () {
            for await (const entry of origIterator()) {
                await handleDirent(p, entry)
                yield entry
            }
        }
        ;(dir.read as any) = async function handleDirRead(...args: any[]) {
            if (typeof args[args.length - 1] === 'function') {
                const cb = args[args.length - 1]
                args[args.length - 1] = async function handleDirReadCb(
                    err: Error,
                    entry: Dirent
                ) {
                    cb(err, entry ? await handleDirent(p, entry) : null)
                }
                origRead(...args)
            } else {
                const entry = await origRead(...args)
                if (entry) {
                    await handleDirent(p, entry)
                }
                return entry
            }
        }
        const origReadSync: any = dir.readSync.bind(dir)
        ;(dir.readSync as any) = function handleDirReadSync() {
            return handleDirentSync(p, origReadSync()) // intentionally sync for simplicity
        }

        return dir
    }

    function handleDirent(p: string, v: Dirent): Promise<Dirent> {
        return new Promise(function handleDirentExecutor(resolve, reject) {
            if (!v.isSymbolicLink()) {
                return resolve(v)
            }
            const f = path.resolve(p, v.name)
            return guardedReadLink(f, handleDirentReadLinkCb)
            function handleDirentReadLinkCb(str: string) {
                if (f != str) {
                    return resolve(v)
                }
                // There are no hops so we should hide the fact that the file is a symlink
                v.isSymbolicLink = () => false
                origRealpath(f, function handleDirentRealpathCb(err, str) {
                    if (err) {
                        throw err
                    }
                    fs.stat(str, function handleDirentStatCb(err, stat) {
                        if (err) {
                            throw err
                        }
                        patchDirent(v, stat)
                        resolve(v)
                    })
                })
            }
        })
    }

    function handleDirentSync(p: string, v: Dirent | null): void {
        if (v && v.isSymbolicLink) {
            if (v.isSymbolicLink()) {
                const f = path.resolve(p, v.name)
                if (f == guardedReadLinkSync(f)) {
                    // There are no hops so we should hide the fact that the file is a symlink
                    v.isSymbolicLink = () => false
                    const stat = fs.statSync(origRealpathSync(f))
                    patchDirent(v, stat)
                }
            }
        }
    }

    function nextHop(loc: string, cb: (next: string | false) => void): void {
        let nested = ''
        let maybe = loc
        let escapedHop: string | false = false

        readHopLink(maybe, function readNextHop(link) {
            if (link === HOP_NOT_FOUND) {
                return cb(undefined)
            }

            if (link !== HOP_NON_LINK) {
                if (nested) {
                    link = link + path.sep + nested
                }

                if (!isEscape(loc, link)) {
                    return cb(link)
                }
                if (!escapedHop) {
                    escapedHop = link
                }
            }

            const dirname = path.dirname(maybe)
            if (
                !dirname ||
                dirname == maybe ||
                dirname == '.' ||
                dirname == '/'
            ) {
                // not a link
                return cb(escapedHop)
            }
            nested = path.basename(maybe) + (nested ? path.sep + nested : '')
            maybe = dirname
            readHopLink(maybe, readNextHop)
        })
    }

    const hopLinkCache = Object.create(null) as { [f: string]: HopResults }

    /**
     * Read the contents of the symlink located at path p.
     *
     * If the file does not exist, returns HOP_NOT_FOUND.
     * If the file is not a symlink, returns HOP_NON_LINK.
     */
    function readHopLinkSync(p: string): HopResults {
        if (hopLinkCache[p]) {
            return hopLinkCache[p]
        }

        let link: HopResults

        try {
            if (origLstatSync(p).isSymbolicLink()) {
                link = origReadlinkSync(p) as string
                if (link) {
                    if (!path.isAbsolute(link)) {
                        link = path.resolve(path.dirname(p), link)
                    }
                } else {
                    link = HOP_NON_LINK
                }
            } else {
                link = HOP_NON_LINK
            }
        } catch (err) {
            if (err.code === 'ENOENT') {
                // file does not exist
                link = HOP_NOT_FOUND
            } else {
                link = HOP_NON_LINK
            }
        }

        hopLinkCache[p] = link
        return link
    }

    function readHopLink(p: string, cb: (l: HopResults) => void) {
        if (hopLinkCache[p]) {
            return cb(hopLinkCache[p])
        }

        origReadlink(p, function readHopLinkCb(err: Error, link: string) {
            if (err) {
                let result: HopResults

                if ((err as any).code === 'ENOENT') {
                    // file does not exist
                    result = HOP_NOT_FOUND
                } else {
                    result = HOP_NON_LINK
                }

                hopLinkCache[p] = result
                return cb(result)
            }

            if (link === undefined) {
                hopLinkCache[p] = HOP_NON_LINK
                return cb(HOP_NON_LINK)
            }

            if (!path.isAbsolute(link)) {
                link = path.resolve(path.dirname(p), link)
            }

            hopLinkCache[p] = link
            cb(link)
        })
    }

    /**
     * Takes one hop in symlink traversal (i.e.: at most one symlink in a path is resolved, and only
     * resolved one step).
     *
     * For each return condition, resolves the "rightmost" symlink e.g. if
     * resolving `/a/b/c`, where `/a/b` -> `../d` and `a/b/c` -> `../f` then in
     * theory you could take two possible hops, either `/a/b/c` -> `/a/d/c` or
     * `/a/b/c` -> `/a/b/f` (both would resolve to the same file). Assuming
     * neither are escapes (or both are), this function returns `/a/b/f` (breaks
     * ties by resolving the rightmost hop).
     *
     * However, note that if it were something like `c` -> `/g`, `/a` is our only root,
     * then we would return `/a/d/c` (as it is not an escape, whereas `/g` is).
     *
     * The way most downstream consumers use this in the context of preventing sandbox escapes
     * is to resolve as many symlink hops as possible that do NOT escape the sandbox, then
     * on the first hop that does, just return the path of the symlink itself.
     *
     * Returns:
     * - If we can resolve a symlink that does not lead to an escape: returns the new target path.
     * - If the only available symlink(s) lead to an escape: returns the target path of resolving the
     *  rightmost symlink.
     * - If there are no symlinks to resolve: returns false.
     * - If `loc` is not a valid path (no file at that path): returns undefined.
     */
    function nextHopSync(loc: string): string | false | undefined {
        // Loop invariant: maybe + nested = loc
        // i.e.: nested tracks the segments of the path that have been "consumed" as we traverse up the directory tree.
        let nested = ''
        // Path of current file we're evaluating (could be a dir or symlink, "file" in the linux sense).
        // maybe traverses up the directory tree each loop iteration until a termination condition is hit:
        // /a/b/c -> /a/b -> /a -> /
        let maybe = loc
        // Stores the first target path that escaped the root.
        let escapedHop: string | false = false

        for (;;) {
            let link = readHopLinkSync(maybe)

            if (link === HOP_NOT_FOUND) {
                // maybe points to a non-existent file
                return undefined
            }

            if (link !== HOP_NON_LINK) {
                // `maybe` is a symlink targeting `link`.
                if (nested) {
                    // Re-add the child path components to the target path.
                    // e.g.: If loc was /a/b/c and /a/b is a symlink targeting /d, then /a/b/c
                    // should resolve to /d/c, so link = /d/c after this line.
                    link = link + path.sep + nested
                }

                if (!isEscape(loc, link)) {
                    // This symlink is not an escape, return the target path.
                    return link
                }

                // This symlink is an escape.
                if (!escapedHop) {
                    // This symlink is the first escape we've encountered.
                    // Record the target.
                    escapedHop = link
                }
            }

            // At this point the following cases:
            // - maybe is not a symlink
            // - maybe is a symlink that escapes the root

            // dirname stores the parent dir of current candidate path.
            const dirname = path.dirname(maybe)
            if (
                !dirname ||
                // This should catch terminal conditions when maybe is like:
                // "/", ".", or "C:"
                dirname == maybe ||
                dirname == '.' ||
                dirname == '/'
            ) {
                // We have traversed up the parent directories, return the
                // first escape we encountered.
                return escapedHop
            }

            nested = path.basename(maybe) + (nested ? path.sep + nested : '')

            // Go up the directory tree, try parent dir as next potential link.
            maybe = dirname

            // Loop invariant restored: maybe + nested = loc
        }
    }

    function guardedReadLink(start: string, cb: (str: string) => void): void {
        let loc = start
        return nextHop(loc, guardedReadLinkHopCb)
        function guardedReadLinkHopCb(next: string | false) {
            if (!next) {
                // we're no longer hopping but we haven't escaped;
                // something funky happened in the filesystem
                return cb(loc)
            }
            if (isEscape(loc, next)) {
                // this hop takes us out of the guard
                return cb(loc)
            }
            return cb(next)
        }
    }

    /**
     * Takes one hop in symlink traversal (preferring hops that don't escape),
     * and returns the target of the symlink if it does not escape the sandbox.
     * Or: returns the symlink path itself if it escapes the sandbox.
     *
     * If the next hop would escape the sandbox, returns `start`.
     * If `start` is not a symlink (nor has any symlink components), returns `start`.
     */
    function guardedReadLinkSync(start: string): string {
        let loc = start
        let next: string | false = nextHopSync(loc)
        if (!next) {
            // we're no longer hopping but we haven't escaped;
            // something funky happened in the filesystem
            // Or we were passed a non-symlink/non-existent file.
            return loc
        }
        if (isEscape(loc, next)) {
            // this hop takes us out of the guard
            return loc
        }
        return next
    }

    function unguardedRealPath(
        start: string,
        cb: (err: Error, str?: string) => void
    ): void {
        start = stringifyPathLike(start) // handle the "undefined" case (matches behavior as fs.realpath)
        function oneHop(loc, cb) {
            nextHop(loc, function oneHopeNextCb(next) {
                if (next == undefined) {
                    // file does not exist (broken link)
                    return cb(enoent('realpath', start))
                } else if (!next) {
                    // we've hit a real file
                    return cb(null, loc)
                }
                oneHop(next, cb)
            })
        }
        oneHop(start, cb)
    }

    function guardedRealPath(
        start: PathLike,
        cb: (err: Error, str?: string) => void,
        escapedRoot: string = undefined
    ): void {
        start = stringifyPathLike(start) // handle the "undefined" case (matches behavior as fs.realpath)
        function oneHop(loc: string, cb: (err: Error, str?: string) => void) {
            nextHop(loc, function guardedRealPathHopCb(next) {
                if (!next) {
                    // we're no longer hopping but we haven't escaped
                    return fs.exists(loc, function guardedRealPathExistsCb(e) {
                        if (e) {
                            // we hit a real file within the guard and can go no further
                            return cb(null, loc)
                        } else {
                            // something funky happened in the filesystem
                            return cb(enoent('realpath', start))
                        }
                    })
                }
                if (
                    escapedRoot
                        ? isEscape(loc, next, [escapedRoot])
                        : isEscape(loc, next)
                ) {
                    // this hop takes us out of the guard
                    return cb(null, loc)
                }
                oneHop(next, cb)
            })
        }
        oneHop(start, cb)
    }

    /**
     * Fully resolves all symlinks in a path, (theoretically equivalent to intrinsic `realpath`).
     */
    function unguardedRealPathSync(start: string): string {
        start = stringifyPathLike(start) // handle the "undefined" case (matches behavior as fs.realpathSync)
        for (let loc = start, next; ; loc = next) {
            next = nextHopSync(loc)
            if (next == undefined) {
                // file does not exist (broken link)
                throw enoent('realpath', start)
            } else if (!next) {
                // we've hit a real file
                return loc
            }
        }
    }

    /**
     * "Guarded" realpath implementation.
     *
     * This means it traverses all symlinks that do not lead to an escape, then returns the path.
     */
    function guardedRealPathSync(
        start: PathLike,
        escapedRoot: string = undefined
    ): string {
        start = stringifyPathLike(start) // handle the "undefined" case (matches behavior as fs.realpathSync)
        for (let loc = start, next: string | false; ; loc = next as string) {
            next = nextHopSync(loc)
            if (!next) {
                // we're no longer hopping but we haven't escaped
                if (fs.existsSync(loc)) {
                    // we hit a real file within the guard and can go no further
                    return loc
                } else {
                    // something funky happened in the filesystem; throw ENOENT
                    throw enoent('realpath', start)
                }
            }
            if (
                escapedRoot
                    ? isEscape(loc, next, [escapedRoot])
                    : isEscape(loc, next)
            ) {
                // this hop takes us out of the guard
                return loc
            }
        }
    }

    // OUR PATCH SECTION FOR NODE INTERNAL LSTAT BINDING
    // All credit goes to `devversion` on Github for sharing the patch solution:
    // https://github.com/aspect-build/rules_js/issues/362#issuecomment-2950303149
    if (useLstatPatch) {
        // We guard the `require` statements to avoid triggering the warning message
        // when the patch isn't enabled.
        const { internalBinding } = require('internal/test/binding')
        const { getStatsFromBinding } = require('internal/fs/utils')
        const internalFs = internalBinding('fs')

        const _originalLStatFsInternal = internalFs.lstat;

        // Function overload declarations from https://github.com/nodejs/node/blob/3c351c272fcae369434b3cc0cc58284eb6c02279/typings/internalBinding/fs.d.ts
        function _originalLStatFs(path: StringOrBuffer, useBigint: boolean, req: InternalFSBinding.FSReqCallback<Float64Array | BigUint64Array>): void;
        function _originalLStatFs(path: StringOrBuffer, useBigint: true, req: InternalFSBinding.FSReqCallback<BigUint64Array>): void;
        function _originalLStatFs(path: StringOrBuffer, useBigint: false, req: InternalFSBinding.FSReqCallback<Float64Array>): void;
        function _originalLStatFs(path: StringOrBuffer, useBigint: boolean, req: undefined, throwIfNoEntry: boolean): Float64Array | BigUint64Array;
        function _originalLStatFs(path: StringOrBuffer, useBigint: true, req: undefined, throwIfNoEntry: boolean): BigUint64Array;
        function _originalLStatFs(path: StringOrBuffer, useBigint: false, req: undefined, throwIfNoEntry: boolean): Float64Array;
        function _originalLStatFs(path: StringOrBuffer, useBigint: boolean, usePromises: typeof kUsePromises): Promise<Float64Array | BigUint64Array>;
        function _originalLStatFs(path: StringOrBuffer, useBigint: true, usePromises: typeof kUsePromises): Promise<BigUint64Array>;
        function _originalLStatFs(path: StringOrBuffer, useBigint: false, usePromises: typeof kUsePromises): Promise<Float64Array>;
        // Implementation
        function _originalLStatFs(...args: any[]): any {
            return _originalLStatFsInternal(...args);
        }

        const _originalStatFsInternal = internalFs.stat;
        function _originalStatFs(path: StringOrBuffer, useBigint: boolean, req: InternalFSBinding.FSReqCallback<Float64Array | BigUint64Array>): void;
        function _originalStatFs(path: StringOrBuffer, useBigint: true, req: InternalFSBinding.FSReqCallback<BigUint64Array>): void;
        function _originalStatFs(path: StringOrBuffer, useBigint: false, req: InternalFSBinding.FSReqCallback<Float64Array>): void;
        function _originalStatFs(path: StringOrBuffer, useBigint: boolean, req: undefined, throwIfNoEntry: boolean): Float64Array | BigUint64Array;
        function _originalStatFs(path: StringOrBuffer, useBigint: true, req: undefined, throwIfNoEntry: boolean): BigUint64Array;
        function _originalStatFs(path: StringOrBuffer, useBigint: false, req: undefined, throwIfNoEntry: boolean): Float64Array;
        function _originalStatFs(path: StringOrBuffer, useBigint: boolean, usePromises: typeof kUsePromises): Promise<Float64Array | BigUint64Array>;
        function _originalStatFs(path: StringOrBuffer, useBigint: true, usePromises: typeof kUsePromises): Promise<BigUint64Array>;
        function _originalStatFs(path: StringOrBuffer, useBigint: false, usePromises: typeof kUsePromises): Promise<Float64Array>;
        function _originalStatFs(...args: any[]): any {
            return _originalStatFsInternal(...args);
        }

        if (internalFs.lstat) {
            // Almost same logic as existing patcher, just that we use `getStatsFromBinding`.

            /**
             * Guard the stats object returned from the internal lstat call (called as a shim layer on the result returned from the internal lstat call).
             */
            const guardInternalStats = (path: string, bigint: boolean, stats: Float64Array | BigUint64Array, cb: (err: Error, stats: Float64Array | BigUint64Array) => void) => {
                const statsObj = getStatsFromBinding(stats)
                if (!statsObj.isSymbolicLink()) {
                    // the file is not a symbolic link so there is nothing more to do
                    return cb(null, stats)
                }

                path = resolvePathLike(path)
                if (!isInBazelRoot(path)) {
                    // The file didn't start in a bazel root, so no escaping to fix.
                    return cb(null, stats)
                }

                return guardedReadLink(path, (str) => {
                    if (str != path) {
                        // there are one or more hops within the guards so there is nothing more to do
                        return cb(null, stats)
                    }
                    // there are no hops so lets report the stats of the real file;
                    // we can't use origRealPath here since that function calls lstat internally
                    // which can result in an infinite loop
                    return unguardedRealPath(path, (err: Error, realPath?: string) => {
                        if (err) {
                            if ((err as any).code === 'ENOENT') {
                                // broken link so there is nothing more to do
                                return cb(null, stats)
                            }
                            return cb(err, null)
                        }
                        // Call _originalStatFs on the real path to get the actual file stats
                        // We use stat (not lstat) because we want the stats of the target file.
                        const statReq = new internalFs.FSReqCallback(bigint)
                        statReq.oncomplete = (err: Error, realStats: Float64Array | BigUint64Array) => {
                            if (err) {
                                if ((err as any).code === 'ENOENT') {
                                    // broken link so there is nothing more to do
                                    return cb(null, stats)
                                }
                                return cb(err, null)
                            }
                            return cb(null, realStats)
                        }
                        return _originalStatFs(realPath, bigint, statReq)
                    })
                })
            }

            /**
             * Guard the stats object returned from the internal lstat call (called as a shim layer on the result returned from the internal lstat call).
             */
            // Almost same logic as existing patcher, just that we use `getStatsFromBinding`.
            const guardInternalStatsSync = (path: string, bigint: boolean, throwIfNoEntry: boolean, stats: Float64Array | BigUint64Array) => {
                // No stats available.
                if (!stats) {
                    return stats
                }

                const statsObj = getStatsFromBinding(stats)
                if (!statsObj.isSymbolicLink()) {
                    // the file is not a symbolic link so there is nothing more to do
                    return stats
                }

                path = resolvePathLike(path)
                if (!isInBazelRoot(path)) {
                    // The path isn't within a bazel root so there's technically no "escape" to fix.
                    // e.g.: if program tries to access `/tmp` we don't want to patch that.
                    return stats
                }

                const guardedReadLink = guardedReadLinkSync(path)
                if (guardedReadLink != path) {
                    // There are one or more hops within the guards so we are safe to let the
                    // caller know it's a symlink (as even if they follow it they'll be within
                    // sandbox).
                    return stats
                }
                try {
                    // There are no hops so lets report the stats of the real file since
                    // lstat on a normal file should return the what stat would;

                    // We can just call `stat` directly since it resolves symlinks (which is
                    // what we want here).
                    return _originalStatFs(path, bigint, undefined, throwIfNoEntry)
                } catch (err) {
                    if (err.code === 'ENOENT') {
                        // broken link so there is nothing more to do
                        return stats
                    }
                    throw err
                }
            }

            internalFs.lstat = function (
                path: string,
                bigint: boolean,
                reqCallbackOrUsePromises: InternalFSBinding.FSReqCallback | symbol,
                throwIfNoEntry: boolean
            ) {
                // NOTE(tenzin): This is a very targeted/hacky way to check if
                // we should apply guarding that comes from the original patch.
                // Also the check against whether the stack trace includes eeguardStats
                // seems unnecessary for correctness (in theory our patch should only ever call
                // into the internal fs functions, which should never themselves
                // call eeguardStats. And even if the passed callback references
                // a patched fs function, the stack trace should no longer
                // include the eeguardStats function, because it would've been
                // popped off stack by the time callback is invoked).
                const st = new Error().stack

                const inFinalizeResolution = st.includes(
                    'finalizeResolution (node:internal/modules/esm/resolve'
                )
                const inGuardInternalStats = st.includes('guardInternalStats')
                // For both correctness and speed we only apply guarding logic when
                // we're inside of the ESM resolver's finalizeResolution function (which
                // is the one that calls realpath to escape the sandbox). When we removed
                // the guarding the patch was both slower, and incorrect (e2e demo test
                // would fail). I think this is because without the guard we can end up
                // in cases where patched fs.lstat calls patched internalFs.lstat, which
                // is not the semantics that the patched fs.lstat expects.
                const needsGuarding =
                    inFinalizeResolution && !inGuardInternalStats
                if (!needsGuarding) {
                    return _originalLStatFs.call(
                        internalFs,
                        path,
                        bigint,
                        reqCallbackOrUsePromises,
                        throwIfNoEntry
                    )
                }

                if (typeof reqCallbackOrUsePromises === 'symbol') {
                    const usePromises = reqCallbackOrUsePromises;
                    return _originalLStatFs
                        .call(
                            internalFs,
                            path,
                            bigint,
                            usePromises,
                            throwIfNoEntry
                        )
                        .then((stats) => {
                            return new Promise((resolve, reject) => {
                                guardInternalStats(
                                    path,
                                    bigint,
                                    stats,
                                    (err, guardedStats) => {
                                        err
                                            ? reject(err)
                                            : resolve(guardedStats)
                                    }
                                )
                            })
                        })
                } else if (reqCallbackOrUsePromises !== undefined) {
                    const reqCallback = reqCallbackOrUsePromises;
                    // Just re-use the promise path above.
                    internalFs
                        .lstat(
                            path,
                            bigint,
                            internalFs.kUsePromises,
                            throwIfNoEntry
                        )
                        .then((stats) => reqCallback.oncomplete(null, stats))
                        .catch((err) => reqCallback.oncomplete(err, undefined))
                } else {
                    const stats = _originalLStatFs.call(
                        internalFs,
                        path,
                        bigint,
                        undefined,
                        throwIfNoEntry
                    )
                    if (!stats) {
                        return stats
                    }
                    return guardInternalStatsSync(path, bigint, throwIfNoEntry, stats)
                }
            }
        }
    }
}

// =========================================================================
// generic helper functions
// =========================================================================

export function isSubPath(parent: string, child: string): boolean {
    return (
        parent === child ||
        (child[parent.length] === path.sep && child.startsWith(parent))
    )
}

function stringifyPathLike(p: PathLike): string {
    if (p instanceof URL) {
        return url.fileURLToPath(p)
    } else {
        return String(p)
    }
}

function resolvePathLike(p: PathLike): string {
    return path.resolve(stringifyPathLike(p))
}

function normalizePathLike(p: PathLike): string {
    const s = stringifyPathLike(p)

    // TODO: are URLs always absolute?
    if (!path.isAbsolute(s)) {
        return path.resolve(s)
    } else {
        return path.normalize(s)
    }
}

export function escapeFunction(_roots: string[]) {
    // Ensure roots are always absolute.
    // Sort to ensure escaping multiple roots chooses the longest one.
    const defaultRoots = _roots
        .map((root) => path.resolve(root))
        .sort((a, b) => b.length - a.length)

    /**
     * Detects whether a symlink escapes the provided roots (given the symlinks
     * path and its target path).
     *
     * A symlink is considered an escape when the symlink is within a root but the
     * target is not.
     *
     * If it's not an escape, returns false.
     *
     * If it is an escape, returns the first root that the symlink is within (using
     * the defaultRoots this should be the most specific root that matched).
     */
    function fs_isEscape(
        linkPath: PathLike,
        linkTarget: string,
        roots = defaultRoots
    ): false | string {
        // linkPath is the path of the symlink file itself
        // linkTarget is a path that the symlink points to one or more hops away
        // linkTarget must already be normalized

        linkPath = normalizePathLike(linkPath)

        for (const root of roots) {
            // If the link is in the root check if the realPath has escaped
            if (isSubPath(root, linkPath) && !isSubPath(root, linkTarget)) {
                return root
            }
        }

        return false
    }

    /**
     * Returns true if the path is within one of the provided bazel roots.
     *
     * By default the roots are the execroot (may be sandboxed) and runfiles root
     * (runfiles root should always be subpath of execroot).
     */
    function fs_isInBazelRoot(
        maybeLinkPath: string,
        roots = defaultRoots
    ): boolean {
        // maybeLinkPath is the path which may be a symlink
        // maybeLinkPath must already be normalized

        for (const root of roots) {
            // If the link is in the root check if the realPath has escaped
            if (isSubPath(root, maybeLinkPath)) {
                return true
            }
        }

        return false
    }

    return {
        isEscape: fs_isEscape,
        isInBazelRoot: fs_isInBazelRoot,
    }
}

function once<T>(fn: (...args: unknown[]) => T) {
    let called = false

    return function callOnce(...args: unknown[]) {
        if (called) return
        called = true

        let err: Error | false = false
        try {
            fn(...args)
        } catch (_e) {
            err = _e
        }

        // blow the stack to make sure this doesn't fall into any unresolved promise contexts
        if (err) {
            setImmediate(() => {
                throw err
            })
        }
    }
}

function patchDirent(dirent: Dirent | any, stat: Stats | any): void {
    // add all stat is methods to Dirent instances with their result.
    for (const i in stat) {
        if (i.startsWith('is') && typeof stat[i] === 'function') {
            //
            const result = stat[i]()
            if (result) dirent[i] = () => true
            else dirent[i] = () => false
        }
    }
}

function enoent(s: string, p: PathLike): Error {
    let err = new Error(`ENOENT: no such file or directory, ${s} '${p}'`)
    ;(err as any).errno = -2
    ;(err as any).syscall = s
    ;(err as any).code = 'ENOENT'
    ;(err as any).path = p
    return err
}

function einval(s: string, p: PathLike): Error {
    let err = new Error(`EINVAL: invalid argument, ${s} '${p}'`)
    ;(err as any).errno = -22
    ;(err as any).syscall = s
    ;(err as any).code = 'EINVAL'
    ;(err as any).path = p
    return err
}
