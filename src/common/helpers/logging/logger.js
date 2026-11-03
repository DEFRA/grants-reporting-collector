import { pino } from 'pino'

import { loggerOptions, loggerStream } from '#/plugins/logger-options.js'

const logger = pino(loggerOptions, loggerStream)

export function getLogger() {
  return logger
}

export const trackEvent = (loggerInstance, type, category, properties) => {
  loggerInstance.info({
    event: {
      type,
      category,
      ...properties
    }
  })
}
