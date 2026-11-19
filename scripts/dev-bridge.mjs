import { randomUUID } from 'node:crypto'

export function developmentBridge() {
  return {
    name: 'onebox-development',
    apply: 'serve',
    configureServer(server) {
      const clients = new Set()
      const pending = new Map()
      server.ws.on('onebox:ready', (data, client) => {
        if (!data.native || clients.has(client)) return
        clients.add(client)
        client.socket.once('close', () => clients.delete(client))
      })
      server.ws.on('onebox:prepared', (data, client) => {
        if (!clients.has(client)) return
        const request = pending.get(data.id)
        if (request) {
          pending.delete(data.id)
          clearTimeout(request.timer)
          request.resolve(data)
        }
      })
      server.middlewares.use('/__onebox_dev', async (request, response) => {
        if (!process.env.ONEBOX_DEV_TOKEN ||
            request.headers.authorization !== 'Bearer ' + process.env.ONEBOX_DEV_TOKEN) {
          response.statusCode = 403
          response.end()
          return
        }
        response.setHeader('Content-Type', 'application/json')
        if (request.url === '/status' && request.method === 'GET') {
          response.end(JSON.stringify({ ready: clients.size > 0, windows: clients.size }))
          return
        }
        if (request.url === '/focus' && request.method === 'POST') {
          for (const client of clients) client.send('onebox:focus', {})
          response.end('{}')
          return
        }
        if (request.url === '/resume' && request.method === 'POST') {
          for (const client of clients) client.send('onebox:resume', {})
          response.end('{}')
          return
        }
        if (request.url !== '/prepare' || request.method !== 'POST') {
          response.statusCode = 404
          response.end('{}')
          return
        }
        if (clients.size !== 1) {
          response.statusCode = 409
          response.end(JSON.stringify({ error: 'Waiting for one ready Onebox window' }))
          return
        }
        const id = randomUUID()
        const result = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(id)
            resolve({ error: 'Timed out while saving the current document' })
          }, 30000)
          pending.set(id, { resolve, timer })
          for (const client of clients) client.send('onebox:prepare', { id })
        })
        response.statusCode = result.error ? 409 : 200
        if (result.error) for (const client of clients) client.send('onebox:resume', { id })
        response.end(JSON.stringify(result))
      })
      server.httpServer?.once('close', () => {
        for (const request of pending.values()) {
          clearTimeout(request.timer)
          request.resolve({ error: 'Development server closed' })
        }
        for (const client of clients) client.send('onebox:resume', {})
        pending.clear()
      })
    },
  }
}
