import { describe, it, expect, vi } from 'vitest'
import { getLogger, trackEvent } from './logger.js'

describe('logger helper', () => {
  describe('getLogger', () => {
    it('should create and return a logger instance', () => {
      const logger = getLogger()
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

      trackEvent(mockLogger, 'duplicate-message', 'inbound', {
        reference: 'messageId: ABC123, agreementId: WMG-123-TBC'
      })

      expect(mockLogger.info).toHaveBeenCalledWith({
        event: {
          type: 'duplicate-message',
          category: 'inbound',
          reference: 'messageId: ABC123, agreementId: WMG-123-TBC'
        }
      })
    })

    it('should log an event without additional properties if none provided', () => {
      const mockLogger = {
        info: vi.fn()
      }

      trackEvent(mockLogger, 'duplicate-message', 'inbound')

      expect(mockLogger.info).toHaveBeenCalledWith({
        event: {
          type: 'duplicate-message',
          category: 'inbound'
        }
      })
    })
  })
})
