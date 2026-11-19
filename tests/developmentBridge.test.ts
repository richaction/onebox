import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Connect, ViteDevServer } from 'vite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { developmentBridge } from '../scripts/dev-bridge.mjs'

function bridge() {
  const ws = new EventEmitter()
  const httpServer = new EventEmitter()
  let middleware: Connect.NextHandleFunction
  const server = {
    ws, httpServer,
    middlewares: { use: (_: string, handler: Connect.NextHandleFunction) => { middleware = handler } },
  } as unknown as ViteDevServer
  const configure = developmentBridge().configureServer
  if (typeof configure !== 'function') throw new Error('Missing development bridge')
  configure.call({} as never, server)
  const client = () => ({ socket: new EventEmitter(), send: vi.fn() })
  const request = (url: string, method = 'GET', authorization = 'Bearer test') =>
    new Promise<{ status: number; body: string }>((resolve) => {
      const response = {
        statusCode: 200,
        setHeader: () => {},
        end(body = '') { resolve({ status: this.statusCode, body }) },
      }
      middleware({ url, method, headers: { authorization } } as IncomingMessage,
        response as unknown as ServerResponse, () => {})
    })
  return { ws, httpServer, client, request }
}

describe('development restart bridge', () => {
  beforeEach(() => { vi.stubEnv('ONEBOX_DEV_TOKEN', 'test') })
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })

  it('requires the launcher token', async () => {
    expect((await bridge().request('/status', 'GET', 'invalid')).status).toBe(403)
  })

  it('counts native clients once and removes disconnected windows', async () => {
    const b = bridge()
    const native = b.client()
    b.ws.emit('onebox:ready', { native: false }, b.client())
    b.ws.emit('onebox:ready', { native: true }, native)
    b.ws.emit('onebox:ready', { native: true }, native)
    expect(JSON.parse((await b.request('/status')).body)).toEqual({ ready: true, windows: 1 })
    native.socket.emit('close')
    expect(JSON.parse((await b.request('/status')).body)).toEqual({ ready: false, windows: 0 })
  })

  it('waits for the native window to confirm saving', async () => {
    const b = bridge()
    const native = b.client()
    b.ws.emit('onebox:ready', { native: true }, native)
    const response = b.request('/prepare', 'POST')
    const [event, { id }] = native.send.mock.calls[0]
    expect(event).toBe('onebox:prepare')
    b.ws.emit('onebox:prepared', { id }, native)
    expect((await response).status).toBe(200)
  })

  it('rejects restarts without exactly one window', async () => {
    const b = bridge()
    expect((await b.request('/prepare', 'POST')).status).toBe(409)
    b.ws.emit('onebox:ready', { native: true }, b.client())
    b.ws.emit('onebox:ready', { native: true }, b.client())
    expect((await b.request('/prepare', 'POST')).status).toBe(409)
  })

  it('keeps the window editable when saving fails', async () => {
    const b = bridge()
    const native = b.client()
    b.ws.emit('onebox:ready', { native: true }, native)
    const response = b.request('/prepare', 'POST')
    const id = native.send.mock.calls[0][1].id
    b.ws.emit('onebox:prepared', { id, error: 'Disk full' }, native)
    expect((await response).status).toBe(409)
    expect(native.send).toHaveBeenLastCalledWith('onebox:resume', { id })
  })

  it('cancels a stalled save and resumes editing after the deadline', async () => {
    vi.useFakeTimers()
    const b = bridge()
    const native = b.client()
    b.ws.emit('onebox:ready', { native: true }, native)
    const response = b.request('/prepare', 'POST')
    const id = native.send.mock.calls[0][1].id
    await vi.advanceTimersByTimeAsync(30000)
    expect((await response).status).toBe(409)
    expect(native.send).toHaveBeenLastCalledWith('onebox:resume', { id })
  })
})
