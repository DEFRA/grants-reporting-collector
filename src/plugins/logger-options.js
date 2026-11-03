import { ecsFormat } from '@elastic/ecs-pino-format'
import pinoPretty from 'pino-pretty'
import { config } from '#/config.js'
import { getTraceId } from '@defra/hapi-tracing'

const logConfig = config.get('log')
const serviceName = config.get('serviceName')
const serviceVersion = config.get('serviceVersion')

const logFormat = logConfig.format

export const loggerStream = logFormat === 'pino-pretty' ? pinoPretty() : undefined

const formatOptions =
  logFormat === 'ecs'
    ? ecsFormat({
        serviceVersion,
        serviceName
      })
    : {}

export const loggerOptions = {
  enabled: logConfig.isEnabled,
  ignorePaths: ['/health'],
  redact: {
    paths: logConfig.redact,
    remove: true
  },
  level: logConfig.level,
  ...formatOptions,
  nesting: true,
  mixin() {
    const mixinValues = {}
    const traceId = getTraceId()
    if (traceId) {
      mixinValues.trace = { id: traceId }
    }
    return mixinValues
  }
}
