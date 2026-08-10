import { health } from '#/routes/health.js'

export const router = {
  plugin: {
    name: 'router',
    register: (server, _options) => {
      server.route([health])
    }
  }
}
