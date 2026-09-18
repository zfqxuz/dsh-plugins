/**
 * DSH plugin: common ECS SSH / n8n workflow / GitHub Actions operations.
 *
 * Registers model-facing tools and intentionally uses only Node builtins.
 * SSH/SCP commands target the configured ECS host. GitHub tools wrap `gh`.
 */

import { execFile } from 'node:child_process'
import { existsSync, chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

export const name = 'ecs-n8n-gh'
export const inject = ['tools']

const execFileAsync = promisify(execFile)
const DEFAULT_SSH_KEY = process.env.ECS_SSH_KEY ?? ''
const DEFAULT_WORKSPACE = process.env.DSH_PROJECT_ROOT ?? process.cwd()
const DEFAULT_GH_REPO = process.env.GH_REPO ?? ''

function resolveConfig(config) {
  const c = config ?? {}
  return {
    ecsHost: String(c.ecsHost ?? process.env.ECS_HOST ?? ''),
    ecsUser: String(c.ecsUser ?? process.env.ECS_USER ?? 'root'),
    ecsPort: Number(c.ecsPort ?? process.env.ECS_PORT ?? 22),
    sshKey: String(c.sshKey ?? DEFAULT_SSH_KEY),
    deployDir: String(c.deployDir ?? process.env.DEPLOY_DIR ?? '/opt/touhou-trpg'),
    composeFile: String(c.composeFile ?? 'docker-compose.prod.yml'),
    n8nContainer: String(c.n8nContainer ?? 'touhou-trpg-n8n'),
    workspace: String(c.workspace ?? DEFAULT_WORKSPACE),
    ghRepo: String(c.ghRepo ?? DEFAULT_GH_REPO),
    maxOutput: Number(c.maxOutput ?? 30000)
  }
}

function outputLimit(cfg, text) {
  const max = Number.isFinite(cfg.maxOutput) && cfg.maxOutput > 0 ? cfg.maxOutput : 30000
  if (text.length <= max) return text
  return text.slice(0, max) + `\n...[truncated ${text.length - max} chars]`
}

function ensurePrivateKey(cfg) {
  if (typeof cfg.sshKey !== 'string' || cfg.sshKey.trim() === '') {
    throw new Error('ECS SSH key not configured: set config.sshKey or ECS_SSH_KEY')
  }
  const source = resolve(cfg.sshKey)
  if (!existsSync(source)) {
    throw new Error(`ECS SSH key not found: ${source}`)
  }
  const dir = join(tmpdir(), 'dsh-ecs-n8n-gh')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = join(dir, 'admin.pem')
  const content = readFileSync(source)
  writeFileSync(target, content, { mode: 0o600 })
  chmodSync(target, 0o600)
  return target
}

function sshArgs(cfg) {
  if (typeof cfg.ecsHost !== 'string' || cfg.ecsHost.trim() === '') {
    throw new Error('ECS host not configured: set config.ecsHost or ECS_HOST')
  }
  return [
    '-i', ensurePrivateKey(cfg),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
    '-p', String(cfg.ecsPort),
    `${cfg.ecsUser}@${cfg.ecsHost}`
  ]
}

async function runCommand(bin, args, timeoutMs = 120000) {
  try {
    const result = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8'
    })
    return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  } catch (error) {
    return {
      code: typeof error?.code === 'number' ? error.code : 1,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : String(error?.message ?? error)
    }
  }
}

async function runSsh(cfg, command, timeoutMs = 120000) {
  const result = await runCommand('ssh', [...sshArgs(cfg), command], timeoutMs)
  const body = [result.stdout, result.stderr].filter((part) => part.trim() !== '').join('\n').trim()
  return { code: result.code, text: body.length > 0 ? body : `(ssh exit ${result.code})` }
}

function textTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    execute
  }
}

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)

  ctx.tools.register(textTool(
    'ecs_exec',
    'Run a shell command on the configured ECS server over SSH. Use for docker compose, logs, health checks, and general ECS operations. Returns combined stdout/stderr and exit code.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'Remote shell command to run on ECS.' },
        timeout_ms: { type: 'integer', description: 'Optional timeout in milliseconds, default 120000.' }
      },
      required: ['command']
    },
    async (args) => {
      if (typeof args.command !== 'string' || args.command.trim() === '') throw new Error('command is required')
      const result = await runSsh(cfg, args.command.trim(), typeof args.timeout_ms === 'number' ? args.timeout_ms : 120000)
      return `exit=${result.code}\n${outputLimit(cfg, result.text)}`
    }
  ))

  ctx.tools.register(textTool(
    'ecs_status',
    'Show ECS hostname, Docker containers, and production compose status for the touhou-trpg deployment.',
    { type: 'object', additionalProperties: false, properties: {} },
    async () => {
      const command = [
        'hostname',
        'echo "--- docker ps ---"',
        'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"',
        `echo "--- compose ps ---"`,
        `cd ${cfg.deployDir} && docker compose -f ${cfg.composeFile} ps`
      ].join('; ')
      const result = await runSsh(cfg, command, 60000)
      return `exit=${result.code}\n${outputLimit(cfg, result.text)}`
    }
  ))

  ctx.tools.register(textTool(
    'ecs_upload',
    'Upload a local file to the configured ECS server via SCP. Useful for n8n workflow JSON, compose files, or scripts.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        local_path: { type: 'string', description: 'Local file path.' },
        remote_path: { type: 'string', description: 'Absolute remote path on ECS.' },
        timeout_ms: { type: 'integer', description: 'Optional timeout in milliseconds.' }
      },
      required: ['local_path', 'remote_path']
    },
    async (args) => {
      const localPath = resolve(args.local_path)
      if (!existsSync(localPath) || statSync(localPath).isFile() === false) throw new Error(`local file not found: ${localPath}`)
      const remotePath = String(args.remote_path)
      if (!remotePath.startsWith('/')) throw new Error('remote_path must be absolute')
      const result = await runCommand('scp', [
        '-i', ensurePrivateKey(cfg),
        '-P', String(cfg.ecsPort),
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        localPath,
        `${cfg.ecsUser}@${cfg.ecsHost}:${remotePath}`
      ], typeof args.timeout_ms === 'number' ? args.timeout_ms : 120000)
      return `exit=${result.code}\n${outputLimit(cfg, [result.stdout, result.stderr].filter(Boolean).join('\n')) || 'uploaded'}`
    }
  ))

  ctx.tools.register(textTool(
    'n8n_status',
    'Show n8n container status, health endpoint, recent logs, and active workflow activation state on ECS.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        log_lines: { type: 'integer', description: 'How many recent n8n log lines to return, default 80.' }
      }
    },
    async (args) => {
      const lines = Number.isFinite(args.log_lines) ? Math.max(10, Math.min(300, Math.floor(args.log_lines))) : 80
      const command = [
        `echo "--- container ---"`,
        `docker ps --filter name=${cfg.n8nContainer} --format "{{.Names}} {{.Status}} {{.Ports}}"`,
        `echo "--- health ---"`,
        `curl -sS -m 5 http://127.0.0.1:5678/healthz || true`,
        `echo`,
        `echo "--- logs ---"`,
        `docker logs --tail=${lines} ${cfg.n8nContainer} 2>&1 | tail -${lines}`
      ].join('; ')
      const result = await runSsh(cfg, command, 60000)
      return `exit=${result.code}\n${outputLimit(cfg, result.text)}`
    }
  ))

  ctx.tools.register(textTool(
    'n8n_deploy_workflow',
    'Upload a local n8n workflow JSON to ECS and force-recreate the n8n container so the workflow is imported and published. Defaults to the repo n8n/workflows/module-import.json.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        workflow_path: { type: 'string', description: 'Local workflow JSON path. Defaults to <workspace>/n8n/workflows/module-import.json.' },
        wait_seconds: { type: 'integer', description: 'Seconds to wait for Activated workflow log, default 90.' }
      }
    },
    async (args) => {
      const workflowPath = resolve(args.workflow_path ?? join(cfg.workspace, 'n8n', 'workflows', 'module-import.json'))
      if (!existsSync(workflowPath) || statSync(workflowPath).isFile() === false) {
        throw new Error(`workflow file not found: ${workflowPath}`)
      }
      const remotePath = `${cfg.deployDir}/n8n/workflows/module-import.json`
      const upload = await runCommand('scp', [
        '-i', ensurePrivateKey(cfg),
        '-P', String(cfg.ecsPort),
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        workflowPath,
        `${cfg.ecsUser}@${cfg.ecsHost}:${remotePath}`
      ], 120000)
      if (upload.code !== 0) return `upload failed (exit=${upload.code})\n${outputLimit(cfg, upload.stderr || upload.stdout)}`

      const waitSeconds = Number.isFinite(args.wait_seconds) ? Math.max(10, Math.min(600, Math.floor(args.wait_seconds))) : 90
      const command = [
        `cd ${cfg.deployDir}`,
        `docker compose -f ${cfg.composeFile} up -d --force-recreate ${cfg.n8nContainer}`,
        `for i in $(seq 1 ${Math.ceil(waitSeconds / 3)}); do`,
        `  if docker logs --tail=300 ${cfg.n8nContainer} 2>&1 | grep -q "Activated workflow"; then`,
        `    echo "n8n workflow activated"; exit 0;`,
        `  fi;`,
        `  sleep 3;`,
        `done;`,
        `echo "n8n workflow activation timeout"; exit 1`
      ].join(' ')
      const result = await runSsh(cfg, command, (waitSeconds + 60) * 1000)
      return `exit=${result.code}\n${outputLimit(cfg, result.text)}`
    }
  ))

  ctx.tools.register(textTool(
    'gh_run_list',
    'List recent GitHub Actions runs for the configured repository using the gh CLI.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', description: 'Number of runs to list, default 5, max 20.' }
      }
    },
    async (args) => {
      if (cfg.ghRepo.trim() === '') throw new Error('GitHub repo not configured: set config.ghRepo or GH_REPO')
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(20, Math.floor(args.limit))) : 5
      const result = await runCommand('gh', [
        'run', 'list',
        '--repo', cfg.ghRepo,
        '--limit', String(limit),
        '--json', 'databaseId,status,conclusion,headSha,event,workflowName,createdAt'
      ], 60000)
      if (result.code !== 0) return `exit=${result.code}\n${outputLimit(cfg, result.stderr || result.stdout)}`
      try {
        const runs = JSON.parse(result.stdout)
        return JSON.stringify(runs, null, 2)
      } catch {
        return outputLimit(cfg, result.stdout)
      }
    }
  ))

  ctx.tools.register(textTool(
    'gh_run_view',
    'View a GitHub Actions run by id. Set log_failed=true to return failed-step logs.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        run_id: { type: 'integer', description: 'GitHub Actions run database id.' },
        log_failed: { type: 'boolean', description: 'Return failed-step logs instead of summary.' }
      },
      required: ['run_id']
    },
    async (args) => {
      if (cfg.ghRepo.trim() === '') throw new Error('GitHub repo not configured: set config.ghRepo or GH_REPO')
      const runId = Number(args.run_id)
      if (Number.isFinite(runId) === false) throw new Error('run_id must be a number')
      const ghArgs = ['run', 'view', String(runId), '--repo', cfg.ghRepo]
      if (args.log_failed === true) ghArgs.push('--log-failed')
      const result = await runCommand('gh', ghArgs, 120000)
      return `exit=${result.code}\n${outputLimit(cfg, result.stdout || result.stderr)}`
    }
  ))
}
