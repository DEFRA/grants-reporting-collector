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
      insertOne: vi.fn().mockResolvedValue({})
    })
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    validateReportingEvent.mockReturnValue({ valid: true })
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

    expect(mockLogger.info).toHaveBeenCalledWith('Received New Reporting event: {"messageId":"123"}')
    expect(mockMetrics.counter).toHaveBeenCalledWith('reporting-message-received')
    expect(mockMetrics.counter).toHaveBeenCalledWith('reporting-message-received-success')
    expect(uploadBlob).toHaveBeenCalledWith(
      mockLogger,
      'reporting-events/2023-01-01T00:00:00Z.json',
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
      eventData: { status: 'agreed' }
    }
    await expect(
      processInputMessage(mockDb, mockMetrics, validMessage, mockLogger, { messageId: '123' })
    ).rejects.toThrow('not successful')
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
      eventData: { status: 'agreed' }
    }
    const attributes = { messageId: 'msg-1', agreementId: 'agr-1' }
    const sentTimestamp = '2023-01-01T00:00:00Z'

    await processInputMessage(mockDb, mockMetrics, message, mockLogger, attributes, sentTimestamp)

    expect(mockDb.collection().insertOne).toHaveBeenCalledWith({
      _id: 'msg-1',
      processedAt: expect.any(Date)
    })
    expect(uploadBlob).not.toHaveBeenCalled()
    expect(mockLogger.info).toHaveBeenCalledWith('Receipt of a duplicate message: msg-1')
    expect(trackEvent).toHaveBeenCalledWith(mockLogger, 'duplicate-message', 'inbound', {
      reference: 'messageId: msg-1, agreementId: agr-1'
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
      eventData: { status: 'agreed' }
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
      eventData: { status: 'agreed' }
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
