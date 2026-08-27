import hapiPulse from 'hapi-pulse'
import { getLogger } from '#/common/helpers/logging/logger.js'

const tenSeconds = 10 * 1000

export const pulse = {
  plugin: hapiPulse,
  options: {
    logger: getLogger(),
    timeout: tenSeconds
  }
}
