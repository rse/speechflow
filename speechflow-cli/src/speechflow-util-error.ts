/*
**  SpeechFlow - Speech Processing Flow Graph
**  Copyright (c) 2024-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  helper function for promise-based timeout  */
export function timeoutPromise<T = void> (duration: number = 10 * 1000, info = "timeout") {
    return new Promise<T>((resolve, reject) => {
        setTimeout(() => { reject(new Error(info)) }, duration)
    })
}

/*  helper function for retrieving an Error object  */
export function ensureError (error: unknown, prefix?: string, debug = false): Error {
    if (error instanceof Error && prefix === undefined && debug === false)
        return error
    let msg = error instanceof Error ?
        error.message : String(error)
    if (prefix)
        msg = `${prefix}: ${msg}`
    if (debug && error instanceof Error)
        msg = `${msg}\n${error.stack}`
    if (error instanceof Error) {
        const err = new Error(msg, { cause: error })
        err.stack = error.stack
        return err
    }
    else
        return new Error(msg)
}

/*  helper function for retrieving a Promise object  */
export function ensurePromise<T> (arg: T | Promise<T>): Promise<T> {
    if (!(arg instanceof Promise))
        arg = Promise.resolve(arg)
    return arg
}

/*  helper function for running the finally code of "run"  */
function runFinally (onfinally?: () => void) {
    if (!onfinally)
        return
    try { onfinally() }
    catch (_error: unknown) { /*  ignored  */ }
}

/*  helper type for ensuring T contains no Promise  */
type runNoPromise<T> =
    [ T ] extends [ Promise<any> ] ? never : T

/*  run a synchronous or asynchronous action  */
export function run<T, X extends runNoPromise<T> | never> (
    action:      () => X,
    oncatch?:    (error: Error) => X | never,
    onfinally?:  () => void
): X
export function run<T, X extends runNoPromise<T> | never> (
    description: string,
    action:      () => X,
    oncatch?:    (error: Error) => X | never,
    onfinally?:  () => void
): X
export function run<T, X extends (T | Promise<T>)> (
    action:      () => X,
    oncatch?:    (error: Error) => X,
    onfinally?:  () => void
): Promise<T>
export function run<T, X extends (T | Promise<T>)> (
    description: string,
    action:      () => X,
    oncatch?:    (error: Error) => X,
    onfinally?:  () => void
): Promise<T>
export function run<T> (
    ...args: any[]
): T | Promise<T> | never {
    /*  support overloaded signatures  */
    let description: string | undefined
    let action:      () => T | Promise<T> | never
    let oncatch:     (error: Error) => T | Promise<T> | never
    let onfinally:   () => void
    if (typeof args[0] === "string") {
        description = args[0]
        action      = args[1]
        oncatch     = args[2]
        onfinally   = args[3]
    }
    else {
        action      = args[0]
        oncatch     = args[1]
        onfinally   = args[2]
    }

    /*  perform the action  */
    let result: T | Promise<T>
    try {
        result = action()
    }
    catch (arg: unknown) {
        /*  synchronous case (error branch)  */
        let error = ensureError(arg, description)
        if (oncatch) {
            try {
                result = oncatch(error)
            }
            catch (arg: unknown) {
                error = ensureError(arg, description)
                runFinally(onfinally)
                throw error
            }
            runFinally(onfinally)
            return result
        }
        runFinally(onfinally)
        throw error
    }
    if (result instanceof Promise) {
        /*  asynchronous case (result or error branch)  */
        return result.catch((arg: unknown) => {
            /*  asynchronous case (error branch)  */
            let error = ensureError(arg, description)
            if (oncatch) {
                try {
                    return oncatch(error)
                }
                catch (arg: unknown) {
                    error = ensureError(arg, description)
                    throw error
                }
            }
            throw error
        }).finally(() => {
            /*  asynchronous case (result and error branch)  */
            runFinally(onfinally)
        })
    }
    else {
        /*  synchronous case (result branch)  */
        runFinally(onfinally)
        return result
    }
}

/*  run a synchronous or asynchronous action  */
/* eslint @typescript-eslint/unified-signatures: off */
export function runner<T, X extends runNoPromise<T> | never, F extends (...args: any[]) => X> (
    action:      F,
    oncatch?:    (error: Error) => X | never,
    onfinally?:  () => void
): F
export function runner<T, X extends runNoPromise<T> | never, F extends (...args: any[]) => X> (
    description: string,
    action:      F,
    oncatch?:    (error: Error) => X | never,
    onfinally?:  () => void
): F
export function runner<T, X extends (T | Promise<T>), F extends (...args: any[]) => Promise<T>> (
    action:      F,
    oncatch?:    (error: Error) => X,
    onfinally?:  () => void
): F
export function runner<T, X extends (T | Promise<T>), F extends (...args: any[]) => Promise<T>> (
    description: string,
    action:      F,
    oncatch?:    (error: Error) => X,
    onfinally?:  () => void
): F
export function runner<T> (
    ...args: any[]
): (...args: any[]) => T | Promise<T> | never {
    /*  support overloaded signatures  */
    let description: string | undefined
    let action:      (...args: any[]) => T | Promise<T> | never
    let oncatch:     (error: Error) => T | Promise<T> | never
    let onfinally:   () => void
    if (typeof args[0] === "string") {
        description = args[0]
        action      = args[1]
        oncatch     = args[2]
        onfinally   = args[3]
    }
    else {
        action      = args[0]
        oncatch     = args[1]
        onfinally   = args[2]
    }

    /*  wrap the "run" operation on "action" into function
        which exposes the signature of "action"  */
    return (...args: any[]) => {
        if (description)
            return run(description, () => action(...args), oncatch, onfinally)
        else
            return run(() => action(...args), oncatch, onfinally)
    }
}
