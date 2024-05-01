import { generatePromptFooConfiguration } from "genaiscript-core/src/test"
import { buildProject } from "./build"
import {
    EXEC_MAX_BUFFER,
    GENAISCRIPT_FOLDER,
    JSON5TryParse,
    ResponseStatus,
    PromptScriptTestRunOptions,
    YAMLStringify,
    arrayify,
    host,
    logInfo,
    logVerbose,
    normalizeFloat,
    parseKeyValuePairs,
    promptFooDriver,
    serializeError,
    PROMPTFOO_CONFIG_DIR,
    PROMPTFOO_CACHE_PATH,
    FILES_NOT_FOUND_ERROR_CODE,
    ErrorObject,
    MarkdownTrace,
} from "genaiscript-core"
import { writeFile } from "node:fs/promises"
import { execa } from "execa"
import { join, resolve } from "node:path"
import { emptyDir, ensureDir } from "fs-extra"
import type { EvaluateSummary, OutputFile } from "promptfoo"
import { PROMPTFOO_VERSION } from "./version"

function parseModelSpec(m: string): ModelOptions {
    const values = parseKeyValuePairs(m)
    if (Object.keys(values).length)
        return {
            model: values["m"],
            temperature: normalizeFloat(values["t"]),
            topP: normalizeFloat(values["p"]),
        }
    else return { model: m }
}

async function resolveTestProvider(script: PromptScript) {
    const token = await host.getSecretToken(script)
    if (token && token.type === "azure") return token.base
    return undefined
}

export interface PromptScriptTestResult extends ResponseStatus {
    script: string
    config: any
    value?: EvaluateSummary
}

export interface PromptScriptTestRun extends ResponseStatus {
    value?: PromptScriptTestResult[]
}

function createEnv() {
    return {
        ...process.env,
        PROMPTFOO_CACHE_PATH: PROMPTFOO_CACHE_PATH,
        PROMPTFOO_CONFIG_DIR: PROMPTFOO_CONFIG_DIR,
        PROMPTFOO_DISABLE_TELEMETRY: "1",
        PROMPTFOO_DISABLE_UPDATE: "1",
    }
}

export async function runPromptScriptTests(
    ids: string[],
    options: PromptScriptTestRunOptions & {
        out?: string
        cli?: string
        removeOut?: boolean
        cache?: boolean
        verbose?: boolean
        write?: boolean
    }
): Promise<PromptScriptTestRun> {
    const prj = await buildProject()
    const scripts = prj.templates
        .filter((t) => arrayify(t.tests)?.length)
        .filter((t) => !ids?.length || ids.includes(t.id))
    if (!scripts.length)
        return {
            ok: false,
            status: FILES_NOT_FOUND_ERROR_CODE,
            error: serializeError(new Error("no tests found")),
        }

    const cli = options.cli || resolve(__filename)
    const out = options.out || join(GENAISCRIPT_FOLDER, "tests")
    const provider = join(out, "provider.mjs")
    const models = options?.models
    logInfo(`writing tests to ${out}`)

    if (options?.removeOut) await emptyDir(out)
    await ensureDir(out)
    await writeFile(provider, promptFooDriver)

    const configurations: { script: PromptScript; configuration: string }[] = []
    for (const script of scripts) {
        const fn = out
            ? join(out, `${script.id}.promptfoo.yaml`)
            : script.filename.replace(/\.genai\.js$/, ".promptfoo.yaml")
        logInfo(`  ${fn}`)
        const testProvider =
            options?.testProvider || (await resolveTestProvider(scripts[0]))
        const config = generatePromptFooConfiguration(script, {
            out,
            cli,
            models: models?.map(parseModelSpec),
            provider: "provider.mjs",
            testProvider,
        })
        const yaml = YAMLStringify(config)
        await writeFile(fn, yaml)
        logVerbose(yaml)
        configurations.push({ script, configuration: fn })
    }

    logVerbose(`running tests with promptfoo`)
    const results: PromptScriptTestResult[] = []
    for (const config of configurations) {
        const { script, configuration } = config
        const outJson = configuration.replace(/\.yaml$/, ".res.json")
        const cmd = "npx"
        const args = [
            "--yes",
            `promptfoo@${PROMPTFOO_VERSION}`,
            "eval",
            "--config",
            configuration,
            "--max-concurrency",
            "1",
        ]
        if (!options.cache) args.push("--no-cache")
        if (options.verbose) args.push("--verbose")
        args.push("--output", outJson)
        logVerbose(`  ${cmd} ${args.join(" ")}`)
        const exec = execa(cmd, args, {
            preferLocal: true,
            cleanup: true,
            stripFinalNewline: true,
            buffer: false,
            env: createEnv(),
            stdio: "inherit",
        })
        let status: number
        let error: ErrorObject
        try {
            const res = await exec
            status = res.exitCode
        } catch (e) {
            status = e.errno
            error = serializeError(e)
        }
        const promptfooResults = JSON5TryParse(outJson) as OutputFile
        results.push({
            status,
            ok: status === 0,
            error,
            script: script.id,
            config: promptfooResults?.config,
            value: promptfooResults?.results,
        })
    }

    return {
        ok: results.every(({ ok }) => ok),
        status: results.find((r) => r.status !== 0)?.status,
        value: results,
    }
}

export async function scriptsTest(
    ids: string[],
    options: PromptScriptTestRunOptions & {
        out?: string
        cli?: string
        removeOut?: boolean
        cache?: boolean
        verbose?: boolean
        write?: boolean
    }
) {
    const { status, value = [] } = await runPromptScriptTests(ids, options)
    const trace = new MarkdownTrace()
    trace.log(
        `tests: ${value.filter((r) => r.ok).length} success, ${value.filter((r) => !r.ok).length} failed`
    )
    for (const result of value) trace.resultItem(result.ok, result.script)
    console.log(trace.content)
    process.exit(status)
}

export async function scriptTestsView() {
    const cmd = `npx`
    const args = ["--yes", "promptfoo@latest", "view", "-y"]
    console.debug(`launching promptfoo result server`)
    await execa(cmd, args, {
        cleanup: true,
        env: createEnv(),
        stdio: "inherit",
    })
}
