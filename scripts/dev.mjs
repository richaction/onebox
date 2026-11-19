import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { watch } from 'node:fs'
import { createServer, createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
const key = createHash('sha256').update(root).digest('hex').slice(0, 16)
const directory = join(tmpdir(), 'onebox-dev-' + key)
const socket = process.platform === 'win32' ? '\\\\.\\pipe\\onebox-dev-' + key : join(directory, 'control.sock')
const log = join(directory, 'development.log')
const command = process.argv[2] ?? 'start'
const token = process.env.ONEBOX_DEV_TOKEN ?? randomBytes(24).toString('hex')
const cli = join(root, 'node_modules/@tauri-apps/cli/tauri.js')
const frontendPort = 1420

async function control(action) {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket)
    let data = ''
    connection.setTimeout(45000, () => connection.destroy(new Error('Development request timed out')))
    connection.once('connect', () => connection.end(JSON.stringify({ action }) + '\n'))
    connection.on('data', (chunk) => { data += chunk })
    connection.once('error', reject)
    connection.once('end', () => {
      try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid response from development process')) }
    })
  })
}

async function frontend(action, method = 'GET') {
  const response = await fetch('http://localhost:' + frontendPort + '/__onebox_dev/' + action, {
    method, headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(35000),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'Development server unavailable')
  return result
}

async function launch() {
  const lockPath = join(directory, 'launch.lock')
  let lock
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      lock = await open(lockPath, 'wx')
      await lock.writeFile(String(process.pid))
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try { return await control('start') } catch (error) {
        if (!['ECONNREFUSED', 'ENOENT'].includes(error.code)) throw error
      }
      try {
        const pid = Number(await readFile(lockPath, 'utf8'))
        if (pid > 0) {
          try { process.kill(pid, 0) } catch (error) {
            if (error.code === 'ESRCH') await unlink(lockPath)
          }
        } else if (Date.now() - (await stat(lockPath)).mtimeMs > 10000) {
          await unlink(lockPath)
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      await delay(100)
    }
  }
  if (!lock) throw new Error('Timed out waiting for the Onebox development launcher')
  try {
    // Recheck after acquiring the lock: concurrent launchers may have started it.
    try { return await control('start') } catch (error) {
      if (!['ECONNREFUSED', 'ENOENT'].includes(error.code)) throw error
    }
    if (process.platform !== 'win32') await unlink(socket).catch(() => {})
    const output = await open(log, 'a')
    const daemon = spawn(process.execPath, [script, 'serve'], {
      cwd: root, detached: true, stdio: ['ignore', output.fd, output.fd],
      env: { ...process.env, ONEBOX_DEV_TOKEN: token },
    })
    daemon.unref()
    await output.close()
    for (let attempt = 0; attempt < 100; attempt++) {
      try { return await control('status') } catch { await delay(100) }
    }
    throw new Error('Could not start development process. Check ' + log)
  } finally {
    await lock.close()
    await unlink(lockPath).catch(() => {})
  }
}

async function serve() {
  let child
  let state = 'starting'
  let failure
  let stopping = false
  let restarting
  let restartAgain = false
  let timer
  let readiness
  let windows = 0
  const status = () => ({ state, pid: child?.pid, windows, log, error: failure })

  const start = () => {
    failure = undefined
    state = 'starting'
    windows = 0
    const current = spawn(process.execPath, [cli, 'dev', '--no-watch'], {
      cwd: root,
      env: { ...process.env, ONEBOX_DEV_TOKEN: token },
      detached: process.platform !== 'win32',
      stdio: 'inherit',
    })
    child = current
    current.once('error', (error) => {
      failure = error.message
      state = 'failed'
    })
    current.once('exit', (code, signal) => {
      if (child !== current) return
      child = undefined
      clearInterval(readiness)
      if (!restarting && !stopping) {
        state = code === 0 ? 'stopped' : 'failed'
        failure = code ? 'Development process exited with code ' + code : undefined
      }
      console.log('[onebox] Process exited', code, signal ?? '')
    })
    readiness = setInterval(async () => {
      if (child !== current || restarting) return
      try {
        const health = await frontend('status')
        windows = health.windows
        if (health.ready) {
          if (state !== 'running') console.log('[onebox] One window ready, frontend hot updates enabled')
          state = 'running'
        }
      } catch { /* The frontend may still be starting or compiling. */ }
    }, 1500)
    readiness.unref()
  }

  const stopChild = async () => {
    clearInterval(readiness)
    const current = child
    if (!current || current.exitCode !== null) return
    const exited = new Promise((resolve) => current.once('exit', resolve))
    if (process.platform === 'win32') current.kill('SIGINT')
    else process.kill(-current.pid, 'SIGINT')
    await Promise.race([exited, delay(10000)])
    if (child === current) {
      if (process.platform === 'win32') current.kill('SIGKILL')
      else process.kill(-current.pid, 'SIGKILL')
      await exited
    }
  }

  const prepare = async () => {
    if (!child) return
    const deadline = Date.now() + 120000
    while (Date.now() < deadline && child) {
      let health
      try { health = await frontend('status') } catch { /* Wait for the build and WebView. */ }
      if (health?.ready) {
        await frontend('prepare', 'POST')
        return
      }
      await delay(500)
    }
    if (child) throw new Error('Onebox is not ready to save before restarting. Check ' + log)
  }

  const restart = () => {
    if (stopping) return Promise.resolve()
    if (restarting) {
      restartAgain = true
      return restarting
    }
    restarting = (async () => {
      do {
        restartAgain = false
        await prepare()
        state = 'restarting'
        console.log('[onebox] Saved session, restarting the native process')
        await stopChild()
        if (!stopping) start()
      } while (restartAgain && !stopping)
    })().catch(async (error) => {
      await frontend('resume', 'POST').catch(() => {})
      failure = error.message
      state = child ? 'running' : 'failed'
      console.error('[onebox]', failure)
      throw error
    }).finally(() => { restarting = undefined })
    return restarting
  }

  const server = createServer({ allowHalfOpen: true }, (connection) => {
    let data = ''
    connection.on('data', (chunk) => {
      data += chunk
      if (data.length > 1024) connection.destroy()
    })
    connection.on('error', () => {})
    connection.once('end', async () => {
      try {
        const { action } = JSON.parse(data)
        if (action === 'restart') await restart()
        if (action === 'start') {
          if (!child && !restarting) start()
          else await frontend('focus', 'POST').catch(() => {})
        }
        if (action === 'stop') {
          if (restarting) await restarting
          stopping = true
          try { await prepare() } catch (error) { stopping = false; throw error }
          state = 'stopping'
          await stopChild()
          clearTimeout(timer)
          watcher.close()
          server.close()
          if (process.platform !== 'win32') await unlink(socket).catch(() => {})
        }
        connection.end(JSON.stringify(status()) + '\n')
      } catch (error) {
        connection.end(JSON.stringify({ ...status(), error: error.message }) + '\n')
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  const watcher = watch(join(root, 'src-tauri'), { recursive: true }, (_, filename) => {
    if (!filename || stopping) return
    const normalized = filename.toString().replaceAll('\\', '/')
    if (normalized.startsWith('target/') || normalized.startsWith('gen/')) return
    if (!(normalized.endsWith('.rs') || normalized.endsWith('.toml') || normalized.endsWith('.json') ||
          normalized.endsWith('.lock') || normalized.startsWith('icons/'))) return
    clearTimeout(timer)
    timer = setTimeout(() => void restart().catch(() => {}), 600)
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    void (async () => {
      try {
        await prepare()
        stopping = true
        await stopChild()
        watcher.close()
        server.close()
        if (process.platform !== 'win32') await unlink(socket).catch(() => {})
      } catch (error) { console.error(error.message) }
    })()
  })
  start()
}

if (command === 'serve') {
  await serve()
} else {
  if (!['start', 'status', 'restart', 'stop'].includes(command)) throw new Error('Unknown development command')
  await mkdir(directory, { recursive: true })
  let result
  try {
    result = await control(command)
  } catch (error) {
    if (!['ECONNREFUSED', 'ENOENT'].includes(error.code)) throw error
    if (command === 'status' || command === 'stop') {
      result = { state: 'stopped', log }
    } else {
      result = await launch()
    }
  }
  console.log(JSON.stringify(result, null, 2))
  if (result.error) process.exitCode = 1
}
