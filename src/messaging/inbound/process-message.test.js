import { processInputMessage, setupS3Client } from './process-message.js'
import { initialiseClient, uploadBlob } from '@defra/grants-config-utils/s3-interactions'
import { MONGODB_DUPLICATE_KEY_ERROR } from '#/common/constants.js'
import { trackEvent } from '#/common/helpers/logging/logger.js'
import { config } from '#/config.js'
import { validateReportingEvent } from '@defra/grants-reporting-publisher'

vi.mock('@defra/grants-config-utils/s3-interactions')
vi.mock('#/common/helpers/logging/logger.js')
vi.mock('@defra/grants-reporting-publisher')
vi.mock('#/config.js', () => ({
  config: {
    get: vi.fn((key) => {
      if (key === 'log') {
        return {
          isEnabled: true,
          level: 'info',
          format: 'pino-pretty',
          redact: []
        }
      }
      return undefined
    })
  }
}))

describe('Process Message test', () => {
  const mockLogger = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }

  const mockMetrics = {
    counter: vi.fn()
  }

  const mockDb = {
    collection: vi.fn().mockReturnValue({
      insertOne: vi.fn().mockResolvedValue({}),
      deleteOne: vi.fn().mockResolvedValue({})
    })
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    validateReportingEvent.mockImplementation((message) => ({
      valid: true,
      value: message
    }))
  })

  it('should log info and call uploadBlob with correct parameters', async () => {
    uploadBlob.mockResolvedValueOnce(undefined)
    const validMessage = {
      user: 'test-user',
      sessionId: 'session-123',
      correlationId: 'corr-123',
      datetime: '2023-01-01T00:00:00Z',
      version: '1.0.0',
      application: 'test-app',
      service: 'test-service',
      eventData: {
        eventType: 'AGREEMENT_CREATED',
        agreementId: 'grant-123',
        accounts: {
          sbi: '12345'
        },
        status: 'agreed',
        details: {
          grantId: 'grant-123'
        }
      }
    }
    await processInputMessage(
      mockDb,
      mockMetrics,
      validMessage,
      mockLogger,
      { messageId: '123' },
      '2023-01-01T00:00:00Z'
    )

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Received New Reporting event (AGREEMENT_CREATED): {"messageId":"123"}'
    )
    expect(mockMetrics.counter).toHaveBeenCalledWith('reporting-message-received')
    expect(mockMetrics.counter).toHaveBeenCalledWith('reporting-message-received-success')
    expect(uploadBlob).toHaveBeenCalledWith(
      mockLogger,
      'reporting-events/test-service/AGREEMENT_CREATED/2023-01-01T00:00:00Z.json',
      JSON.stringify(validMessage)
    )
  })

  it('should throw error if upload fails', async () => {
    uploadBlob.mockRejectedValueOnce(new Error('not successful'))
    const validMessage = {
      user: 'test-user',
      correlationId: 'corr-123',
      datetime: '2023-01-01T00:00:00Z',
      version: '1.0.0',
      application: 'test-app',
      service: 'test-service',
      eventData: {
        eventType: 'AGREEMENT_CREATED',
        agreementId: 'grant-123',
        status: 'agreed'
      }
    }
    await expect(
      processInputMessage(mockDb, mockMetrics, validMessage, mockLogger, { messageId: '123' })
    ).rejects.toThrow('not successful')
  })

  it('should remove processed marker from MongoDB when S3 upload fails so that message processing can be retried', async () => {
    const processedMessages = new Set()
    mockDb.collection().insertOne.mockImplementation(async ({ _id }) => {
      if (processedMessages.has(_id)) {
        const error = new Error('Duplicate key')
        error.code = MONGODB_DUPLICATE_KEY_ERROR
        throw error
      }
      processedMessages.add(_id)
      return { insertedId: _id }
    })
    mockDb.collection().deleteOne.mockImplementation(async ({ _id }) => {
      processedMessages.delete(_id)
      return { deletedCount: 1 }
    })

    const message = {
      user: 'test-user',
      correlationId: 'corr-123',
      datetime: '2023-01-01T00:00:00Z',
      version: '1.0.0',
      application: 'test-app',
      service: 'test-service',
      eventData: {
        eventType: 'AGREEMENT_CREATED',
        agreementId: 'grant-123',
        status: 'agreed'
      }
    }
    const attributes = { messageId: 'retry-msg-123' }
    const sentTimestamp = '2023-01-01T00:00:00Z'

    // First attempt: uploadBlob fails
    uploadBlob.mockRejectedValueOnce(new Error('S3 upload failed'))

    await expect(
      processInputMessage(mockDb, mockMetrics, message, mockLogger, attributes, sentTimestamp)
    ).rejects.toThrow('S3 upload failed')

    expect(mockLogger.error).toHaveBeenCalledWith('Failed to upload Reporting event to S3: S3 upload failed')
    expect(mockDb.collection).toHaveBeenCalledWith('processed_messages')
    expect(mockDb.collection().deleteOne).toHaveBeenCalledWith({ _id: 'retry-msg-123' })
    expect(processedMessages.has('retry-msg-123')).toBe(false)

    // Second attempt (retry): uploadBlob succeeds, and message is not marked as duplicate
    uploadBlob.mockResolvedValueOnce(undefined)

    await processInputMessage(mockDb, mockMetrics, message, mockLogger, attributes, sentTimestamp)

    expect(uploadBlob).toHaveBeenCalledWith(
      mockLogger,
      'reporting-events/test-service/AGREEMENT_CREATED/2023-01-01T00:00:00Z.json',
      JSON.stringify(message)
    )
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Received New Reporting event (AGREEMENT_CREATED): {"messageId":"retry-msg-123"}'
    )
    expect(processedMessages.has('retry-msg-123')).toBe(true)
  })

  it('should throw error and log if reporting event is invalid', async () => {
    validateReportingEvent.mockReturnValueOnce({ valid: false, errors: 'some error' })

    const invalidMessage = {
      grant: 'some-grant',
      version: '1.0.0'
    }
    await expect(
      processInputMessage(mockDb, mockMetrics, invalidMessage, mockLogger, { messageId: '123' })
    ).rejects.toThrow('Invalid Reporting event, cannot process: some error')

    expect(mockMetrics.counter).toHaveBeenCalledWith('reporting-message-received-invalid')
    expect(mockLogger.error).toHaveBeenCalledWith('Invalid Reporting event, cannot process: some error')
  })

  it('should skip processing and log duplicate if messageId already exists', async () => {
    const error = new Error('Duplicate key')
    error.code = MONGODB_DUPLICATE_KEY_ERROR
    mockDb.collection().insertOne.mockRejectedValueOnce(error)

    const message = {
      user: 'test-user',
      correlationId: 'corr-123',
      datetime: '2023-01-01T00:00:00Z',
      version: '1.0.0',
      application: 'test-app',
      service: 'test-service',
      eventData: {
        eventType: 'AGREEMENT_CREATED',
        agreementId: 'agr-1',
        status: 'agreed'
      }
    }
    const attributes = { messageId: 'msg-1' }
    const sentTimestamp = '2023-01-01T00:00:00Z'

    await processInputMessage(mockDb, mockMetrics, message, mockLogger, attributes, sentTimestamp)

    expect(mockDb.collection().insertOne).toHaveBeenCalledWith({
      _id: 'msg-1',
      processedAt: expect.any(Date)
    })
    expect(uploadBlob).not.toHaveBeenCalled()
    expect(mockLogger.info).toHaveBeenCalledWith('Receipt of a duplicate message: msg-1')
    expect(trackEvent).toHaveBeenCalledWith(mockLogger, 'duplicate-message', 'inbound', {
      reference: 'messageId: msg-1, agreementId: agr-1, eventType: AGREEMENT_CREATED'
    })
  })

  it('should process message if messageId is missing', async () => {
    const message = {
      user: 'test-user',
      correlationId: 'corr-123',
      datetime: '2023-01-01T00:00:00Z',
      version: '1.0.0',
      application: 'test-app',
      service: 'test-service',
      eventData: {
        eventType: 'AGREEMENT_CREATED',
        agreementId: 'grant-123',
        status: 'agreed'
      }
    }
    uploadBlob.mockResolvedValueOnce(undefined)
    await processInputMessage(mockDb, mockMetrics, message, mockLogger, {}, '2023-01-01T00:00:00Z')

    expect(mockDb.collection).not.toHaveBeenCalled()
    expect(uploadBlob).toHaveBeenCalled()
    expect(mockMetrics.counter).toHaveBeenCalledWith('reporting-message-received')
  })

  it('should rethrow error if MongoDB error is not a duplicate key error', async () => {
    const error = new Error('Connection error')
    error.code = 50
    mockDb.collection().insertOne.mockRejectedValueOnce(error)

    const message = {
      user: 'test-user',
      correlationId: 'corr-123',
      datetime: '2023-01-01T00:00:00Z',
      version: '1.0.0',
      application: 'test-app',
      service: 'test-service',
      eventData: {
        eventType: 'AGREEMENT_CREATED',
        agreementId: 'grant-123',
        status: 'agreed'
      }
    }
    await expect(
      processInputMessage(mockDb, mockMetrics, message, mockLogger, { messageId: 'msg-1' }, '2023-01-01T00:00:00Z')
    ).rejects.toThrow('Connection error')
  })

  it('setupS3Client should initialise S3 client with config values', () => {
    config.get.mockImplementation((key) => {
      const configs = {
        'aws.region': 'us-east-1',
        'aws.endpointUrl': 'http://localhost:4566',
        'aws.s3.forcePathStyle': true,
        'aws.s3.bucketName': 'test-bucket'
      }
      return configs[key]
    })

    setupS3Client()

    expect(initialiseClient).toHaveBeenCalledWith({
      region: 'us-east-1',
      endpoint: 'http://localhost:4566',
      forcePathStyle: true,
      bucketNameOverride: 'test-bucket'
    })
  })
})
