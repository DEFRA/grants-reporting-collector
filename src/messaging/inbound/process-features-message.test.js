import { describe, it, expect, vi, beforeEach } from 'vitest'
import { processFeaturesMessage } from './process-features-message.js'

describe('processFeaturesMessage', () => {
  const mockLogger = {
    info: vi.fn(),
    error: vi.fn()
  }

  const defaultAttributes = {
    name: 'SOME_CONTROL',
    scopes: ['service.grants-reporting'],
    updatedBy: 'test-user',
    valueType: 'boolean'
  }

  const mockMessage = { some: 'data' }
  const sentTimestamp = '123456789'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should log message receipt', async () => {
    await processFeaturesMessage(mockMessage, mockLogger, defaultAttributes, sentTimestamp)

    expect(mockLogger.info).toHaveBeenCalledWith(
      `Received Feature control notification: SOME_CONTROL (boolean), scopes: ${defaultAttributes.scopes}, updatedBy: test-user`
    )
  })

  it('should catch and log error if thrown', async () => {
    // Cause an error by passing null attributes
    await processFeaturesMessage(mockMessage, mockLogger, null, sentTimestamp)

    expect(mockLogger.error).toHaveBeenCalledWith(expect.any(TypeError), 'Unable to process Input request:')
  })
})
