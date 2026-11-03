import { describe, it, expect, vi } from 'vitest'
import { createLogger, trackEvent } from './logger.js'

describe('logger helper', () => {
  describe('createLogger', () => {
    it('should create and return a logger instance', () => {
      const logger = createLogger()
      expect(logger).toBeDefined()
      expect(typeof logger.info).toBe('function')
      expect(typeof logger.warn).toBe('function')
      expect(typeof logger.error).toBe('function')
    })
  })

  describe('trackEvent', () => {
    it('should log an event with type, category, and additional properties', () => {
      const mockLogger = {
        info: vi.fn()
      }

      trackEvent(mockLogger, 'scoring.outcome', 'sector', {
        reference: 'score: 25, value: SOFT_AND_CANE_FRUIT'
      })

      expect(mockLogger.info).toHaveBeenCalledWith({
        event: {
          type: 'scoring.outcome',
          category: 'sector',
          reference: 'score: 25, value: SOFT_AND_CANE_FRUIT'
        }
      })
    })

    it('should log an event without additional properties if none provided', () => {
      const mockLogger = {
        info: vi.fn()
      }

      trackEvent(mockLogger, 'scoring.outcome', 'total')

      expect(mockLogger.info).toHaveBeenCalledWith({
        event: {
          type: 'scoring.outcome',
          category: 'total'
        }
      })
    })
  })
})
