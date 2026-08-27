import { processInputMessage } from './process-message.js'
import { uploadBlob } from '@defra/grants-config-utils/s3-interactions'
import { MONGODB_DUPLICATE_KEY_ERROR } from '#/common/constants.js'

vi.mock('@defra/grants-config-utils/s3-interactions')

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
  })

  it('should log info and call uploadBlob with correct parameters', async () => {
    uploadBlob.mockResolvedValueOnce(undefined)
    await processInputMessage(
      mockDb,
      mockMetrics,
      {
        grant: 'some-grant',
        version: '1.0.0',
        event: 'created',
        status: 'agreed'
      },
      mockLogger,
      { messageId: '123' },
      '2023-01-01T00:00:00Z'
    )

    expect(mockLogger.info).toHaveBeenCalledWith('Received New Reporting event: {"messageId":"123"}')
    expect(mockMetrics.counter).toHaveBeenCalledWith('reporting-message-received')
    expect(uploadBlob).toHaveBeenCalledWith(
      mockLogger,
      'reporting-events/2023-01-01T00:00:00Z.json',
      '{"grant":"some-grant","version":"1.0.0","event":"created","status":"agreed"}'
    )
  })

  it('should catch and log error if thrown', async () => {
    uploadBlob.mockRejectedValueOnce(new Error('not successful'))
    await processInputMessage(
      mockDb,
      mockMetrics,
      {
        grant: 'some-grant',
        version: '1.0.0'
      },
      mockLogger,
      { messageId: '123' }
    )

    expect(mockLogger.error).toHaveBeenCalledWith(new Error('not successful'), 'Unable to process Reporting event:')
  })

  it('should skip processing and log duplicate if messageId already exists', async () => {
    const error = new Error('Duplicate key')
    error.code = MONGODB_DUPLICATE_KEY_ERROR
    mockDb.collection().insertOne.mockRejectedValueOnce(error)

    const message = { data: 'test' }
    const attributes = { messageId: 'msg-1' }
    const sentTimestamp = '2023-01-01T00:00:00Z'

    await processInputMessage(mockDb, mockMetrics, message, mockLogger, attributes, sentTimestamp)

    expect(mockDb.collection().insertOne).toHaveBeenCalledWith({
      _id: 'msg-1',
      processedAt: expect.any(Date)
    })
    expect(uploadBlob).not.toHaveBeenCalled()
    expect(mockLogger.info).toHaveBeenCalledWith('Receipt of a duplicate message: msg-1')
  })
})
